import * as fs from 'fs';
import * as path from 'path';
import { missingInputHint, writeArtifact } from '../../artifact-paths.js';
import type { RobloxStudioTools } from '../index.js';
import { withArgs } from '../fork-luau.js';
import { clamp, luauValue, parseResult, toolText, type PeerTarget } from '../fork-tools.js';
import type { ForkFeature, ForkHandler } from './feature.js';

type UploadType = 'Audio' | 'Model' | 'Decal' | 'Animation';

// Open Cloud Assets API formats, which do not include .obj.
const EXTENSION_TYPES: Record<string, UploadType> = {
  mp3: 'Audio', ogg: 'Audio', wav: 'Audio', flac: 'Audio',
  fbx: 'Model', gltf: 'Model', glb: 'Model', rbxm: 'Model', rbxmx: 'Model',
  png: 'Decal', jpg: 'Decal', jpeg: 'Decal', bmp: 'Decal', tga: 'Decal',
};
const UPLOAD_TYPES: UploadType[] = ['Audio', 'Model', 'Decal', 'Animation'];
// A saved KeyframeSequence and a model share these extensions, so animations are only chosen with asset_type.
const ANIMATION_EXTENSIONS = new Set(['rbxm', 'rbxmx']);

// Roblox documents a 20 MB cap without saying which MB, so the larger reading never refuses a file Roblox would take.
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_AUDIO_SECONDS = 7 * 60;
// Roblox wants images smaller than 8000x8000, so only a side past 8000 is certainly refused.
const MAX_IMAGE_SIDE = 8000;
const MAX_FILES = 200;
const DISPLAY_NAME_LIMIT = 50;
const RETRIES = 3;
const BACKOFF_MS = 2000;
const EXECUTE = '/api/execute-luau';

// Only a request Roblox refused outright is safe to send again.
const RETRYABLE = /\b429\b|rate limit|too many requests/i;
// Timeouts and status poll failures can come after Roblox created the asset, so a retry could make a second one.
const UNCONFIRMED = /Operation ID:|Image upload status failed|Request timed out|aborted due to timeout/;

export interface UploadRow {
  file: string;
  name: string;
  type: UploadType | null;
  assetId: string | null;
  status: 'pending' | 'uploaded' | 'failed' | 'skipped' | 'unconfirmed';
  error: string | null;
  attempts?: number;
  imageId?: string;
  imageNote?: string;
  sound?: string;
  animation?: string;
  /** Studio path of the AnimationClip an animations_from row was exported from. */
  source?: string;
}

// The image id behind a Decal can only be looked up through a connected Studio.
const IMAGE_NOTE = 'Image id unknown because Studio was not connected or the image was still processing. In Studio, InsertService:LoadAsset with the assetId returns a Decal whose Texture holds it.';

export type UploadOnce = (row: UploadRow) => Promise<{ assetId: string; imageId?: string }>;

type SoundEntry = { name: string; assetId: string; class?: 'Sound' | 'Animation' };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Relative paths read from the artifact folder when one is set, the same place tool outputs land.
function resolveInput(requested: string): string {
  const root = process.env.ROBLOX_MCP_ARTIFACT_DIR?.trim();
  return root ? path.resolve(root, requested) : path.resolve(requested);
}

function extensionOf(file: string): string {
  return path.extname(file).slice(1).toLowerCase();
}

function listDirectory(directory: string, extensions: Set<string>, recursive: boolean, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Cannot read directory ${directory}: ${message(error)}`);
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    // macOS archives carry a ._name AppleDouble file beside every real one.
    if (entry.name.startsWith('.')) continue;
    const full = path.join(directory, entry.name);
    // Dirent does not follow symlinks, so a linked folder can never loop the scan.
    if (entry.isDirectory()) {
      if (recursive) listDirectory(full, extensions, recursive, out);
    } else if (extensions.has(extensionOf(entry.name))) {
      out.push(full);
    }
    if (out.length > MAX_FILES) throw new Error(`More than ${MAX_FILES} files matched, narrow extensions or split the folder.`);
  }
}

function wavSeconds(fd: number, size: number): number | undefined {
  const chunk = Buffer.alloc(20);
  if (fs.readSync(fd, chunk, 0, 12, 0) < 12 || chunk.toString('latin1', 0, 4) !== 'RIFF' || chunk.toString('latin1', 8, 12) !== 'WAVE') return undefined;
  let byteRate = 0;
  for (let offset = 12; offset + 8 <= size;) {
    const read = fs.readSync(fd, chunk, 0, 20, offset);
    const id = chunk.toString('latin1', 0, 4);
    const length = chunk.readUInt32LE(4);
    if (id === 'fmt ' && read >= 20) byteRate = chunk.readUInt32LE(16);
    // Streamed WAVs leave the data size at its maximum, so only the bytes on disk count.
    if (id === 'data') return byteRate > 0 ? Math.min(length, size - offset - 8) / byteRate : undefined;
    offset += 8 + length + (length % 2);
  }
  return undefined;
}

// STREAMINFO is always the first FLAC block and packs a 20 bit sample rate next to a 36 bit sample count.
function flacSeconds(fd: number): number | undefined {
  const head = Buffer.alloc(26);
  if (fs.readSync(fd, head, 0, 26, 0) < 26 || head.toString('latin1', 0, 4) !== 'fLaC' || (head[4] & 0x7f) !== 0) return undefined;
  const rate = (head[18] << 12) | (head[19] << 4) | (head[20] >> 4);
  const samples = (head[21] & 0x0f) * 2 ** 32 + head.readUInt32BE(22);
  return rate > 0 && samples > 0 ? samples / rate : undefined;
}

function pngSize(fd: number): { width: number; height: number } | undefined {
  const head = Buffer.alloc(24);
  if (fs.readSync(fd, head, 0, 24, 0) < 24 || head.toString('latin1', 1, 4) !== 'PNG' || head.toString('latin1', 12, 16) !== 'IHDR') return undefined;
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

// Only limits readable from a fixed header are checked here, mp3, ogg and other images are left to Roblox.
function inspect(file: string, extension: string, size: number): string | undefined {
  const fd = fs.openSync(file, 'r');
  try {
    const seconds = extension === 'wav' ? wavSeconds(fd, size) : extension === 'flac' ? flacSeconds(fd) : undefined;
    if (seconds !== undefined && seconds > MAX_AUDIO_SECONDS) return `${Math.ceil(seconds)} s of audio is over the 7 minute limit`;
    const image = extension === 'png' ? pngSize(fd) : undefined;
    if (image && Math.max(image.width, image.height) > MAX_IMAGE_SIDE) return `${image.width}x${image.height} is over the ${MAX_IMAGE_SIDE} pixel image limit`;
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
}

function check(file: string, extension: string): string | undefined {
  try {
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat) return 'file not found';
    if (!stat.isFile()) return 'not a regular file';
    if (stat.size === 0) return 'empty file';
    if (stat.size > MAX_FILE_BYTES) return `${(stat.size / 1024 / 1024).toFixed(1)} MB is over the 20 MB upload limit`;
    return inspect(file, extension, stat.size);
  } catch (error) {
    return message(error);
  }
}

export function planUploads(body: Record<string, unknown>): UploadRow[] {
  const assetType = body.asset_type ?? undefined;
  if (assetType !== undefined &&!UPLOAD_TYPES.includes(assetType as UploadType)) {
    throw new Error(`asset_type must be one of ${UPLOAD_TYPES.join(', ')}`);
  }
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item !== '') : []);

  const paths = strings(body.files).map(resolveInput);
  let searched: string | undefined;
  if (typeof body.directory === 'string' && body.directory !== '') {
    const requested = strings(body.extensions).map((extension) => extension.replace(/^\./, '').toLowerCase());
    const extensions = new Set(requested.length > 0
      ? requested
      : assetType === 'Animation'
        ? [...ANIMATION_EXTENSIONS]
        : Object.keys(EXTENSION_TYPES).filter((extension) => assetType === undefined || EXTENSION_TYPES[extension] === assetType));
    const directory = resolveInput(body.directory);
    listDirectory(directory, extensions, body.recursive === true, paths);
    searched = `No .${[...extensions].join(', .')} files in ${directory}`;
  }
  const unique = [...new Set(paths)];
  if (unique.length === 0) throw new Error(searched ?? 'Pass files or directory.');
  if (unique.length > MAX_FILES) throw new Error(`${unique.length} files given, at most ${MAX_FILES} per call.`);

  const prefix = typeof body.name_prefix === 'string' ? body.name_prefix : '';
  return unique.map((file): UploadRow => {
    const extension = extensionOf(file);
    const type = assetType === 'Animation' && ANIMATION_EXTENSIONS.has(extension) ? 'Animation' : EXTENSION_TYPES[extension] ?? null;
    const name = `${prefix}${path.basename(file, path.extname(file))}`.slice(0, DISPLAY_NAME_LIMIT);
    const row: UploadRow = { file, name, type, assetId: null, status: 'pending', error: null };
    let problem: string | undefined;
    if (extension === 'obj') problem = 'Open Cloud does not accept .obj, convert it to .fbx or .glb';
    else if (type === null) problem = `unsupported extension .${extension}, use ${Object.keys(EXTENSION_TYPES).join(', ')}`;
    else if (assetType === 'Animation' && type !== 'Animation') problem = `.${extension} cannot upload as Animation, only .rbxm and .rbxmx can`;
    else if (assetType !== undefined && type !== assetType) problem = `.${extension} uploads as ${type}, not ${assetType}`;
    else problem = check(file, extension);
    return problem === undefined ? row : { ...row, status: 'skipped', error: problem };
  });
}

// Resolves early on abort so a cancelled call does not sit out the backoff.
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

async function uploadWithRetry(row: UploadRow, upload: UploadOnce, backoffMs: number, signal?: AbortSignal): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    row.attempts = attempt;
    try {
      const uploaded = await upload(row);
      Object.assign(row, { status: 'uploaded', assetId: uploaded.assetId, error: null });
      if (uploaded.imageId) row.imageId = uploaded.imageId;
      else if (row.type === 'Decal') row.imageNote = IMAGE_NOTE;
      return;
    } catch (error) {
      const text = message(error);
      if (UNCONFIRMED.test(text)) {
        Object.assign(row, { status: 'unconfirmed', error: text });
        return;
      }
      if (attempt > RETRIES || !RETRYABLE.test(text)) {
        Object.assign(row, { status: 'failed', error: text });
        return;
      }
      if (!signal?.aborted) await pause(backoffMs * 2 ** (attempt - 1), signal);
      if (signal?.aborted) {
        Object.assign(row, { status: 'failed', error: `${text} (cancelled before retrying)` });
        return;
      }
    }
  }
}

/** Uploads every pending row in place, at most concurrency at a time, and one failure never stops the rest. */
export async function uploadAll(
  rows: UploadRow[],
  upload: UploadOnce,
  options: { concurrency: number; backoffMs: number; signal?: AbortSignal },
): Promise<void> {
  const queue = rows.filter((row) => row.status === 'pending');
  const worker = async () => {
    for (let row = queue.shift(); row !== undefined; row = queue.shift()) {
      if (options.signal?.aborted) Object.assign(row, { status: 'skipped', error: 'cancelled before upload' });
      else await uploadWithRetry(row, upload, options.backoffMs, options.signal);
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency, queue.length) }, worker));
}

function uploader(tools: RobloxStudioTools, body: Record<string, unknown>): UploadOnce {
  const id = (value: unknown) => (typeof value === 'string' && value !== '' ? value : typeof value === 'number' ? String(value) : undefined);
  const description = typeof body.description === 'string' ? body.description : undefined;
  const userId = id(body.user_id);
  const groupId = id(body.group_id);
  return async (row) => {
    const result = parseResult(await tools.uploadAsset(row.file, row.type!, row.name, description, userId, groupId));
    const response = result.response as Record<string, unknown> | undefined;
    const assetId = response?.assetId;
    if (typeof assetId !== 'string' && typeof assetId !== 'number') {
      const failure = (result.error as { message?: unknown } | undefined)?.message;
      throw new Error(typeof failure === 'string' ? `Asset upload failed: ${failure}` : 'Upload returned no asset ID');
    }
    // A decal's own ID is not what ImageLabel.Image takes, the image asset behind it is.
    const imageId = result.imageId ?? response?.imageId;
    return { assetId: String(assetId), ...(typeof imageId === 'string' || typeof imageId === 'number' ? { imageId: String(imageId) } : {}) };
  };
}

export function soundsLuau(args: { parent: string; sounds: SoundEntry[] }): string {
  return withArgs(String.raw`
if game:GetService("RunService"):IsRunning() then return { error = "create_in edits the edit DataModel, stop the playtest first" } end
local parent = resolve(ARGS.parent)
if parent == nil then return { error = "create_in not found: " .. ARGS.parent } end
if #ARGS.sounds == 0 then return { parent = pathOf(parent), sounds = {} } end

local ChangeHistoryService = game:GetService("ChangeHistoryService")
local recording = nil
pcall(function() recording = ChangeHistoryService:TryBeginRecording("MCP: upload_assets") end)
local results = {}
for index, entry in ARGS.sounds do
	local ok, result = pcall(function()
		local class = entry.class or "Sound"
		-- Matched by name and class, so a Sound and an Animation that share a name stay apart.
		local existing = nil
		for _, child in parent:GetChildren() do
			if child.Name == entry.name and child.ClassName == class then
				existing = child
				break
			end
		end
		local made = existing or Instance.new(class)
		made.Name = entry.name
		if class == "Animation" then
			made.AnimationId = "rbxassetid://" .. entry.assetId
		else
			made.SoundId = "rbxassetid://" .. entry.assetId
		end
		made.Parent = parent
		return { path = pathOf(made), updated = made == existing }
	end)
	results[index] = if ok then result else { error = tostring(result) }
end
if recording then
	pcall(function() ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Commit) end)
end
return { parent = pathOf(parent), sounds = results, undoable = recording ~= nil }
`, args);
}

export function animationSourcesLuau(args: { roots: string[] }): string {
  return withArgs(String.raw`
local found, missing = {}, {}
for _, root in ARGS.roots do
	local instance = resolve(root)
	if instance == nil then
		table.insert(missing, root)
	else
		local candidates = instance:GetDescendants()
		table.insert(candidates, 1, instance)
		for _, item in candidates do
			-- AnimationClip covers both KeyframeSequence and CurveAnimation, the two kinds Roblox accepts as animations.
			if item:IsA("AnimationClip") then
				table.insert(found, { path = pathOf(item), name = item.Name })
			end
		end
	end
end
return { sequences = found, missing = missing }
`, args);
}

interface ExportedAnimations {
  rows: UploadRow[];
  names: Map<UploadRow, string>;
  missing: string[];
}

// Each clip is saved as its own .rbxm in the artifact folder, because Open Cloud takes one animation per file.
async function exportAnimations(
  tools: RobloxStudioTools,
  peer: PeerTarget,
  roots: string[],
  prefix: string,
  room: number,
  instanceId: string | undefined,
): Promise<ExportedAnimations> {
  const listed = luauValue(await tools.forkHost.requestPeer(EXECUTE, { code: animationSourcesLuau({ roots }) }, peer.peerId, 30_000));
  const sequences = (listed.sequences as Array<{ path: string; name: string }> | undefined) ?? [];
  const missing = (listed.missing as string[] | undefined) ?? [];
  if (sequences.length > room) throw new Error(`${sequences.length} animations found, but only ${room} more files fit in one call.`);
  const folder = `uploads/animations-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const used = new Set<string>();
  const rows: UploadRow[] = [];
  const names = new Map<UploadRow, string>();
  for (const sequence of sequences) {
    const base = sequence.name.replace(/[^\w.-]+/g, '_') || 'animation';
    let stem = base;
    for (let count = 2; used.has(stem.toLowerCase()); count++) stem = `${base}_${count}`;
    used.add(stem.toLowerCase());
    const row: UploadRow = {
      file: '', name: `${prefix}${sequence.name}`.slice(0, DISPLAY_NAME_LIMIT), type: 'Animation',
      assetId: null, status: 'pending', error: null, source: sequence.path,
    };
    try {
      const exported = parseResult(await tools.exportRbxm([sequence.path], `${folder}/${stem}.rbxm`, 'edit', instanceId));
      if (typeof exported.output_path !== 'string') throw new Error('export returned no file');
      row.file = exported.output_path;
      const problem = check(row.file, 'rbxm');
      if (problem !== undefined) Object.assign(row, { status: 'skipped', error: problem });
    } catch (error) {
      Object.assign(row, { status: 'skipped', error: `export failed: ${message(error)}` });
    }
    rows.push(row);
    names.set(row, sequence.name);
  }
  return { rows, names, missing };
}

async function editPeer(tools: RobloxStudioTools, instanceId: string | undefined): Promise<PeerTarget> {
  const peers = await tools.forkHost.peerTargets('edit', instanceId);
  if (peers.length !== 1) throw new Error(`create_in needs one edit peer, ${peers.length} matched, pass instance_id`);
  return peers[0];
}

async function placeSounds(tools: RobloxStudioTools, peer: PeerTarget, parent: string, sounds: SoundEntry[]) {
  return luauValue(await tools.forkHost.requestPeer(EXECUTE, { code: soundsLuau({ parent, sounds }) }, peer.peerId, 30_000));
}

// Files sharing a stem would otherwise land on one Sound, the later overwriting the earlier.
// Every stem is reserved first, so hit.wav and hit.ogg never take the name a real hit_2.wav needs.
function soundNames(rows: UploadRow[], labels?: Map<UploadRow, string>): Map<UploadRow, string> {
  const stems = rows.map((row) => labels?.get(row) ?? path.basename(row.file, path.extname(row.file)));
  const used = new Set(stems);
  const claimed = new Set<string>();
  const names = new Map<UploadRow, string>();
  rows.forEach((row, index) => {
    const stem = stems[index];
    let name = stem;
    if (claimed.has(stem)) {
      let count = 2;
      while (used.has(`${stem}_${count}`)) count++;
      name = `${stem}_${count}`;
      used.add(name);
    }
    claimed.add(stem);
    names.set(row, name);
  });
  return names;
}

async function createSounds(
  tools: RobloxStudioTools,
  peer: PeerTarget | undefined,
  parent: string,
  rows: UploadRow[],
  labels: Map<UploadRow, string>,
): Promise<Record<string, unknown>> {
  const audio = rows.filter((row) => row.status === 'uploaded' && (row.type === 'Audio' || row.type === 'Animation'));
  if (!peer || audio.length === 0) return { created: 0, note: 'No audio or animation was uploaded, so nothing was added.' };
  // Named over every planned file of the kind, so an instance keeps its name when another upload in the call fails.
  const names = new Map([
    ...soundNames(rows.filter((row) => row.type === 'Audio')),
    ...soundNames(rows.filter((row) => row.type === 'Animation'), labels),
  ]);
  try {
    const entries = audio.map((row): SoundEntry => ({
      name: names.get(row)!,
      assetId: row.assetId!,
      ...(row.type === 'Animation' ? { class: 'Animation' as const } : {}),
    }));
    const placed = await placeSounds(tools, peer, parent, entries);
    const results = (placed.sounds as Array<{ path?: string; updated?: boolean; error?: string } | undefined>) ?? [];
    const errors: Array<{ file: string; error: string }> = [];
    audio.forEach((row, index) => {
      const result = results[index];
      if (typeof result?.path !== 'string') errors.push({ file: row.file, error: result?.error ?? 'no result' });
      else if (row.type === 'Animation') row.animation = result.path;
      else row.sound = result.path;
    });
    return {
      parent: placed.parent,
      created: results.filter((result) => result?.path && !result.updated).length,
      updated: results.filter((result) => result?.updated).length,
      undoable: placed.undoable === true,
      ...(errors.length > 0 ? { errors } : {}),
    };
  } catch (error) {
    return { error: `Sounds and Animations were not added: ${message(error)}` };
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item !== '') : [];
}

const uploadAssets: ForkHandler = async (tools, body, context) => {
  const instanceId = body.instance_id as string | undefined;
  const roots = stringList(body.animations_from);
  const wantsFiles = stringList(body.files).length > 0 || (typeof body.directory === 'string' && body.directory !== '');
  if (!wantsFiles && roots.length === 0) throw new Error('Pass files, directory or animations_from.');
  const rows = wantsFiles ? planUploads(body) : [];
  const createIn = typeof body.create_in === 'string' && body.create_in !== '' ? body.create_in : undefined;

  let peer: PeerTarget | undefined;
  let labels = new Map<UploadRow, string>();
  let missingRoots: string[] = [];
  if (roots.length > 0) {
    peer = await editPeer(tools, instanceId);
    const prefix = typeof body.name_prefix === 'string' ? body.name_prefix : '';
    const exported = await exportAnimations(tools, peer, roots, prefix, MAX_FILES - rows.length, instanceId);
    rows.push(...exported.rows);
    labels = exported.names;
    missingRoots = exported.missing;
    if (rows.length === 0) {
      throw new Error(missingRoots.length === roots.length
        ? `animations_from not found: ${missingRoots.join(', ')}`
        : `No KeyframeSequence or CurveAnimation under ${roots.join(', ')}.`);
    }
  }

  // Checked before uploading, so a wrong path or a missing Studio costs no upload quota.
  if (createIn && rows.some((row) => row.status === 'pending' && (row.type === 'Audio' || row.type === 'Animation'))) {
    peer ??= await editPeer(tools, instanceId);
    await placeSounds(tools, peer, createIn, []);
  }

  await uploadAll(rows, uploader(tools, body), {
    concurrency: clamp(body.concurrency, 3, 1, 6),
    backoffMs: BACKOFF_MS,
    signal: context?.signal,
  });

  let sounds: Record<string, unknown> | undefined;
  // A cancelled client never reads the result, so it would not learn about the edit.
  if (createIn) sounds = context?.signal?.aborted ? { created: 0, note: 'Cancelled, so no Sounds were added.' } : await createSounds(tools, peer, createIn, rows, labels);

  const count = (status: UploadRow['status']) => rows.filter((row) => row.status === status).length;
  const totals = {
    files: rows.length,
    uploaded: count('uploaded'),
    failed: count('failed'),
    skipped: count('skipped'),
    unconfirmed: count('unconfirmed'),
  };

  let manifest: string | undefined;
  let manifestError: string | undefined;
  if (body.manifest !== false) {
    const createdAt = new Date().toISOString();
    try {
      manifest = writeArtifact(`uploads/${createdAt.replace(/[:.]/g, '-')}.json`, JSON.stringify({ createdAt, totals, files: rows, sounds }, null, 2));
    } catch (error) {
      manifestError = message(error);
    }
  }

  return toolText({
    totals,
    files: rows,
    ...(sounds ? { sounds } : {}),
    ...(missingRoots.length > 0 ? { missing_roots: missingRoots } : {}),
    ...(rows.some((row) => row.error === 'file not found') ? { hint: missingInputHint() } : {}),
    ...(manifest ? { manifest } : {}),
    ...(manifestError ? { manifestError } : {}),
  });
};

export const uploadsFeature: ForkFeature = {
  name: 'uploads',
  definitions: [
    {
      name: 'upload_assets',
      category: 'write',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      description: 'Use to upload many audio, model, image or animation files to Roblox, optionally adding Sounds or Animations in Studio.',
      inputSchema: {
        type: 'object',
        properties: {
          files: { type: 'array', items: { type: 'string' }, description: 'Local file paths.' },
          directory: { type: 'string', description: 'Folder to upload from.' },
          extensions: { type: 'array', items: { type: 'string' }, description: 'Extensions to pick, default all.' },
          recursive: { type: 'boolean', description: 'Include subfolders.' },
          animations_from: { type: 'array', items: { type: 'string' }, description: 'Studio paths whose KeyframeSequences upload as Animations.' },
          asset_type: { type: 'string', enum: UPLOAD_TYPES, description: 'Only accept this type.' },
          name_prefix: { type: 'string', description: 'Asset name prefix.' },
          description: { type: 'string', description: 'Asset description.' },
          user_id: { type: 'string', description: 'Creator user ID.' },
          group_id: { type: 'string', description: 'Creator group ID, wins over user_id.' },
          concurrency: { type: 'number', minimum: 1, maximum: 6, default: 3, description: 'Parallel uploads.' },
          create_in: { type: 'string', description: 'Studio path that gets a Sound or Animation per upload.' },
          manifest: { type: 'boolean', description: 'Write a JSON manifest, default true.' },
          instance_id: { type: 'string', description: 'Studio process ID when ambiguous.' },
        },
      },
    },
  ],
  handlers: { upload_assets: uploadAssets },
  instructions: [
    {
      tools: ['upload_assets'],
      text: 'For more than one asset file use upload_assets, which retries rate limits and records every asset ID in a manifest.',
    },
  ],
  guide: `
## Batch asset uploads

- upload_assets uploads every path in files plus the files in directory that match extensions, with subfolders only when recursive is true, up to ${MAX_FILES} per call.
- The type follows the extension: mp3, ogg, wav and flac are Audio, fbx, glb, gltf, rbxm and rbxmx are Model, and png, jpg, jpeg, bmp and tga are Decal.
- asset_type Animation uploads .rbxm and .rbxmx files as Animations instead of Models, since a saved KeyframeSequence and a model share those extensions.
- animations_from takes Studio paths, such as a rig's AnimSaves, and exports every KeyframeSequence and CurveAnimation under them to its own .rbxm in the artifact folder before uploading it as an Animation. It works alone or together with files.
- Animations used by a group's experience must belong to that group, so pass group_id for team games, or they will not load in live servers.
- Open Cloud does not accept .obj, so convert it to .fbx or .glb first.
- A .gltf that points at separate buffer or texture files cannot be uploaded alone, so prefer .glb.
- Files over 20 MB, unknown extensions, and files that do not match asset_type are skipped before any upload.
- WAV and FLAC files longer than 7 minutes and PNGs wider or taller than 8000 pixels are skipped too, while mp3, ogg and other images are only checked by Roblox.
- Relative paths resolve inside ROBLOX_MCP_ARTIFACT_DIR when it is set.
- A sandboxed server only sees the folders bound into it, so copy a delivery into the artifact folder first.
- Credentials are the same as for upload_asset: ROBLOX_OPEN_CLOUD_API_KEY with asset:write, plus ROBLOX_CREATOR_USER_ID or ROBLOX_CREATOR_GROUP_ID unless user_id or group_id is passed.
- Each asset is named name_prefix plus the file name without its extension, cut to 50 characters.
- Rate limits are retried up to 3 times with exponential backoff, and any other error fails only that file.
- Timeouts and errors while Roblox processes an accepted file are never retried and leave status unconfirmed.
- status unconfirmed means the asset may already exist, so check Creations on the Creator Dashboard before uploading that file again.
- Through Open Cloud a rate limit while polling reads the same as one on the upload itself, so a retried row can rarely leave a duplicate asset.
- Audio is limited to 10 uploads a month, or 100 with ID verification, so count the files before uploading a large folder.
- New audio still goes through moderation, so a Sound can stay silent until Roblox approves it.
- Decal rows also carry imageId, the image asset that ImageLabel.Image needs. Looking it up needs a connected Studio, and without one the row has imageNote instead.
- create_in adds one Sound per uploaded audio file and one Animation per uploaded animation in the edit DataModel, named after the file or the exported clip and pointing at rbxassetid://<id>, as one undo step named MCP: upload_assets.
- Audio files that share a name get Sounds named name_2, name_3 and so on, numbered over every audio file in the call.
- Rerun the same set of files to update the same Sounds, because a smaller set can number them differently.
- An existing Sound with the same name under create_in gets the new SoundId instead of a duplicate.
- create_in is resolved before anything is uploaded, so a wrong path costs no quota.
- Cancelling stops new uploads and adds no Sounds, but uploads already running still finish and are listed in the manifest.
- The manifest lists file, name, type, assetId, status and error for each file. Read it after a lost response instead of uploading again.
- Rows with status failed or skipped can be uploaded again once the cause is fixed.
`,
};
