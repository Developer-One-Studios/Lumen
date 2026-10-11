import { readFile } from 'fs/promises';
import { relative } from 'path';
import {
  formatInstancePath,
  isUnderPath,
  parseInstancePath,
  starterPath,
  type SourcemapIndex,
  type SourcemapResolver,
} from '../../sourcemap.js';
import { withArgs } from '../fork-luau.js';
import { clamp, luauValue, sourcemaps, toolText, type ForkHost, type PeerTarget } from '../fork-tools.js';
import type { ForkFeature } from './feature.js';

const READ_ONLY_PROBE = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const EXECUTE = '/api/execute-luau';
const MAX_SCRIPTS = 5000;
const READ_BATCH = 64;
// Never replicated, so a client cannot hold these scripts at all.
const SERVER_ONLY = ['game.ServerScriptService', 'game.ServerStorage'];

export interface SourceDigest {
  hash: string;
  bytes: number;
}

/** FNV-1a 32 over the bytes, ignoring a BOM, CRLF line ends and one final newline, which editors and Rojo disagree on. */
export function sourceHash(data: Buffer): SourceDigest {
  // latin1 maps every byte to one char code, so this walks the same bytes as the Luau side.
  let text = data.toString('latin1');
  if (text.startsWith('\xef\xbb\xbf')) text = text.slice(3);
  text = text.replace(/\r\n/g, '\n');
  if (text.endsWith('\n')) text = text.slice(0, -1);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return { hash: hash.toString(16).padStart(8, '0'), bytes: text.length };
}

// Must stay byte for byte equivalent to sourceHash.
export const SOURCE_HASH_LUAU = String.raw`
local function hashSource(source)
	if string.sub(source, 1, 3) == "\239\187\191" then source = string.sub(source, 4) end
	source = string.gsub(source, "\r\n", "\n")
	if string.sub(source, -1) == "\n" then source = string.sub(source, 1, -2) end
	local data = buffer.fromstring(source)
	local hash = 2166136261
	for i = 0, buffer.len(data) - 1 do
		hash = bit32.bxor(hash, buffer.readu8(data, i))
		-- The FNV prime is 2^24 + 403. Splitting the product keeps it below 2^53, where doubles stay exact.
		hash = (hash * 403 + bit32.lshift(hash, 24)) % 4294967296
	end
	return string.format("%08x", hash), #source
end
`;

export type SyncRole = 'edit' | 'server' | 'client';

export function verifySyncLuau(args: { role: SyncRole; paths: string[]; hashes: string[] }): string {
  return withArgs(SOURCE_HASH_LUAU + String.raw`
local Players = game:GetService("Players")
local editor = nil
if ARGS.role == "edit" then
	local ok, service = pcall(game.GetService, game, "ScriptEditorService")
	if ok then editor = service end
end
local player = if ARGS.role == "client" then Players.LocalPlayer else nil

-- A client runs the copies in its player containers, not the Starter originals Rojo syncs.
local CLONES = {
	{ prefix = { "StarterPlayer", "StarterPlayerScripts" }, container = function() return player:FindFirstChild("PlayerScripts") end },
	{ prefix = { "StarterPlayer", "StarterCharacterScripts" }, container = function() return player.Character end },
	{ prefix = { "StarterGui" }, container = function() return player:FindFirstChildOfClass("PlayerGui") end },
	{ prefix = { "StarterPack" }, container = function() return player:FindFirstChildOfClass("Backpack") end },
}

local function runningCopy(parts)
	for _, clone in CLONES do
		local matches = #parts > #clone.prefix
		for i, name in clone.prefix do
			if parts[i] ~= name then
				matches = false
				break
			end
		end
		if matches then
			local current = clone.container()
			for i = #clone.prefix + 1, #parts do
				if current == nil then return nil end
				current = current:FindFirstChild(parts[i])
			end
			return current
		end
	end
	return nil
end

local function locate(path)
	if player ~= nil then
		local parts = parsePath(path)
		local copy = if parts then runningCopy(parts) else nil
		if copy ~= nil then return copy end
	end
	return resolve(path)
end

-- Clients receive server Scripts without their source, so only a Client run context can be compared there.
local function serverOnly(script)
	if player == nil or script.ClassName ~= "Script" then return false end
	local ok, context = pcall(function() return (script :: any).RunContext end)
	return not ok or context ~= Enum.RunContext.Client
end

-- The editor holds the text the user sees, which Source can lag while a script is open.
local function readSource(script)
	if editor ~= nil then
		local ok, source = pcall(editor.GetEditorSource, editor, script)
		if ok then return true, source end
	end
	return pcall(function() return (script :: any).Source end)
end

-- Game code can reparent a synced script at runtime, as Cmdr does with its commands, so a script missing from its
-- synced path is looked for by name elsewhere and still counts when its source matches disk.
local requested = {}
for _, path in ARGS.paths do requested[path] = true end
local scriptsByName = nil
local function movedCopy(path, expected)
	local parts = parsePath(path)
	local name = if parts then parts[#parts] else nil
	if name == nil then return nil end
	if scriptsByName == nil then
		scriptsByName = {}
		local ok, all = pcall(game.GetDescendants, game)
		for index, item in if ok then all else {} do
			if index % 5000 == 0 then task.wait() end
			local read, isScript = pcall(function() return item:IsA("LuaSourceContainer") end)
			if read and isScript then
				local list = scriptsByName[item.Name] or {}
				scriptsByName[item.Name] = list
				table.insert(list, item)
			end
		end
	end
	for _, candidate in scriptsByName[name] or {} do
		if not requested[pathOf(candidate)] then
			local ok, source = readSource(candidate)
			if ok and type(source) == "string" and hashSource(source) == expected then return candidate end
		end
	end
	return nil
end

local result = { in_sync = 0, stale = {}, missing = {}, not_script = {}, unreadable = {}, skipped = {} }
local yielded = os.clock()
for i, path in ARGS.paths do
	if os.clock() - yielded > 0.05 then
		task.wait()
		yielded = os.clock()
	end
	local script = locate(path)
	if script == nil then
		local moved = movedCopy(path, ARGS.hashes[i])
		if moved ~= nil then
			result.moved = result.moved or {}
			table.insert(result.moved, { path = path, now = pathOf(moved) })
		else
			table.insert(result.missing, path)
		end
	elseif not script:IsA("LuaSourceContainer") then
		table.insert(result.not_script, path)
	elseif serverOnly(script) then
		table.insert(result.skipped, path)
	else
		local ok, source = readSource(script)
		if not ok or type(source) ~= "string" then
			table.insert(result.unreadable, { path = path, error = tostring(source) })
		else
			local hash, bytes = hashSource(source)
			if hash == ARGS.hashes[i] then
				result.in_sync += 1
			else
				table.insert(result.stale, { path = path, bytes = bytes })
			end
		end
	end
end
return result
`, args);
}

type Expected = { path: string; file: string; digest: SourceDigest };

interface PeerReport {
  in_sync: number;
  stale: Array<{ path: string; bytes: number }>;
  missing: string[];
  moved: Array<{ path: string; now: string }>;
  not_script: string[];
  unreadable: Array<{ path: string; error: string }>;
  skipped: string[];
}

/** Scripts a peer actually compared with disk, and those that differed. */
type PeerCheck = { checked: Set<string>; stale: Set<string>; missing: number };

function asReport(value: Record<string, unknown>): PeerReport {
  const list = <T>(key: string) => (Array.isArray(value[key]) ? value[key] : []) as T[];
  return {
    in_sync: typeof value.in_sync === 'number' ? value.in_sync : 0,
    stale: list('stale'),
    missing: list('missing'),
    moved: list('moved'),
    not_script: list('not_script'),
    unreadable: list('unreadable'),
    skipped: list('skipped'),
  };
}

function checkOf(sent: Expected[], report: PeerReport): PeerCheck {
  const unchecked = new Set([...report.missing, ...report.not_script, ...report.skipped, ...report.unreadable.map((entry) => entry.path)]);
  return {
    checked: new Set(sent.map((entry) => entry.path).filter((path) => !unchecked.has(path))),
    stale: new Set(report.stale.map((entry) => entry.path)),
    missing: report.missing.length,
  };
}

/** A requested path as the sourcemap names it, so a player's runtime copies select the starter scripts they come from. */
function syncedBase(path: string): string | undefined {
  const parts = parseInstancePath(path);
  return parts && formatInstancePath(starterPath(parts) ?? parts);
}

function roleOf(peer: PeerTarget): SyncRole {
  if (peer.role === 'edit') return 'edit';
  return peer.role.startsWith('client') ? 'client' : 'server';
}

async function digestFiles(files: string[]): Promise<Map<string, SourceDigest | null>> {
  const digests = new Map<string, SourceDigest | null>();
  for (let start = 0; start < files.length; start += READ_BATCH) {
    await Promise.all(files.slice(start, start + READ_BATCH).map(async (file) => {
      try {
        digests.set(file, sourceHash(await readFile(file)));
      } catch {
        digests.set(file, null);
      }
    }));
  }
  return digests;
}

function displayFile(index: SourcemapIndex, file: string): string {
  const rel = relative(index.projectRoot, file);
  return rel.startsWith('..') ? file : rel;
}

function scripts(count: number, verb?: [string, string]): string {
  const noun = `${count} script${count === 1 ? '' : 's'}`;
  return verb ? `${noun} ${verb[count === 1 ? 0 : 1]}` : noun;
}

/** Says which side matches disk, since a loader may apply disk changes to playtests while edit Source lags. */
function syncHint(edit: PeerCheck | undefined, runtime: PeerCheck[]): string[] {
  const hints: string[] = [];
  const runtimeStale = new Set(runtime.flatMap((peer) => [...peer.stale]));
  if (edit && edit.stale.size > 0) {
    const checkedAtRuntime = [...edit.stale].filter((path) => runtime.some((peer) => peer.checked.has(path)));
    const staleBoth = checkedAtRuntime.filter((path) => runtimeStale.has(path));
    if (staleBoth.length > 0) {
      hints.push(`${scripts(staleBoth.length, ['differs', 'differ'])} from disk in edit and at runtime, so old code is running. Check the Rojo connection, then restart the playtest.`);
    } else if (checkedAtRuntime.length > 0) {
      hints.push(`Edit Source lags disk for ${scripts(edit.stale.size)} but the running peers match disk, so the code that runs is current. A loader that applies disk changes to playtests does exactly this.`);
    } else {
      hints.push(`Edit Source differs from disk for ${scripts(edit.stale.size)}. A loader that applies disk changes to playtests leaves edit behind, so check a running server or client to see what runs. Without such a loader the Rojo sync is not reaching Studio.`);
    }
  }
  const runtimeOnly = [...runtimeStale].filter((path) => !edit?.stale.has(path));
  const editMatches = runtimeOnly.filter((path) => edit?.checked.has(path)).length;
  const editUnchecked = runtimeOnly.length - editMatches;
  if (editMatches > 0) {
    hints.push(`${scripts(editMatches, ['differs', 'differ'])} from disk at runtime while edit matches, so the playtest started before the change synced. Restart it.`);
  }
  if (editUnchecked > 0) {
    hints.push(`${scripts(editUnchecked, ['differs', 'differ'])} from disk at runtime${edit ? ' and edit holds no readable copy to compare' : ''}. Restart the playtest once the sync has landed.`);
  }
  if (edit && edit.missing > 0) {
    hints.push(`${scripts(edit.missing, ['is', 'are'])} in the sourcemap but missing in edit, so Rojo is not connected or no longer serves them.`);
  }
  return hints;
}

export async function verifySync(
  host: Pick<ForkHost, 'peerTargets' | 'requestPeer'>,
  body: Record<string, unknown>,
  instanceId: string | undefined,
  resolver: SourcemapResolver = sourcemaps,
) {
  if (typeof body.project_root === 'string' && body.project_root !== '') resolver.setProjectRoot(body.project_root);
  const map = await resolver.refresh(body.regenerate === true);
  const index = map.index;
  if (!index) {
    throw new Error(`No Rojo sourcemap (${map.error ?? 'nothing found'}). Pass project_root, the folder holding default.project.json.`);
  }
  const limit = clamp(body.limit, 50, 1, 1000);

  const synced = [...index.byPath.keys()];
  const requested = Array.isArray(body.paths) ? body.paths.filter((item): item is string => typeof item === 'string' && item !== '') : [];
  const bases = requested.map((path) => ({ path, base: syncedBase(path) }));
  const unmatched = bases.filter(({ base }) => base === undefined || !synced.some((path) => isUnderPath(path, base)));
  const selected = synced
    .filter((path) => bases.length === 0 || bases.some(({ base }) => base !== undefined && isUnderPath(path, base)))
    .sort();
  const checkedScripts = selected.slice(0, MAX_SCRIPTS);

  const digests = await digestFiles([...new Set(checkedScripts.map((path) => index.byPath.get(path)!))]);
  const expected: Expected[] = [];
  const goneFromDisk: string[] = [];
  for (const path of checkedScripts) {
    const file = index.byPath.get(path)!;
    const digest = digests.get(file);
    if (digest) expected.push({ path, file, digest });
    else goneFromDisk.push(displayFile(index, file));
  }
  const byPath = new Map(expected.map((entry) => [entry.path, entry]));

  const peers = expected.length > 0
    ? await host.peerTargets(typeof body.peers === 'string' && body.peers !== '' ? body.peers : 'all', instanceId)
    : [];
  const runs = peers.map((peer) => {
    const role = roleOf(peer);
    const sent = role === 'client'
      ? expected.filter((entry) => !SERVER_ONLY.some((base) => isUnderPath(entry.path, base)))
      : expected;
    const code = verifySyncLuau({ role, paths: sent.map((entry) => entry.path), hashes: sent.map((entry) => entry.digest.hash) });
    const reply = host.requestPeer(EXECUTE, { code }, peer.peerId, 120_000).then((response) => asReport(luauValue(response)));
    return { peer, role, sent, reply };
  });
  const settled = await Promise.allSettled(runs.map((run) => run.reply));

  const results: Record<string, unknown> = {};
  let edit: PeerCheck | undefined;
  const runtime: PeerCheck[] = [];
  let allInSync = goneFromDisk.length === 0 && unmatched.length === 0 && expected.length > 0;
  let movedTotal = 0;
  for (const [i, outcome] of settled.entries()) {
    const { peer, role, sent } = runs[i];
    if (outcome.status === 'rejected') {
      allInSync = false;
      results[peer.role] = { error: String(outcome.reason?.message ?? outcome.reason) };
      continue;
    }
    const report = outcome.value;
    // A peer that hides script source reads every script as empty, which says nothing about sync.
    const emptyOnDisk = sent.filter((entry) => entry.digest.bytes === 0).length;
    if (role !== 'edit' && report.stale.length > 0 && report.stale.every((entry) => entry.bytes === 0) && report.in_sync <= emptyOnDisk) {
      allInSync = false;
      results[peer.role] = { source_unavailable: true, note: 'Script Source reads empty on this peer, so it cannot be compared with disk.' };
      continue;
    }
    if (role === 'client') {
      // An empty copy of a non-empty file is that same blind spot for one script, not proof that old code runs.
      const blank = report.stale.filter((entry) => entry.bytes === 0);
      report.stale = report.stale.filter((entry) => entry.bytes !== 0);
      report.unreadable.push(...blank.map((entry) => ({ path: entry.path, error: 'Source reads empty on this client' })));
    }
    const lists = [report.stale, report.missing, report.not_script, report.unreadable];
    if (lists.some((list) => list.length > 0)) allInSync = false;
    movedTotal += report.moved.length;
    const skipped = expected.length - sent.length + report.skipped.length;
    results[peer.role] = {
      in_sync: report.in_sync,
      stale: report.stale.length,
      missing_in_studio: report.missing.length,
      ...(report.moved.length > 0 ? { moved: report.moved.length } : {}),
      ...(skipped > 0 ? { skipped_server_only: skipped } : {}),
      ...(report.stale.length > 0 ? {
        stale_scripts: report.stale.slice(0, limit).map((entry) => {
          const disk = byPath.get(entry.path);
          return { path: entry.path, file: disk ? displayFile(index, disk.file) : null, disk_bytes: disk?.digest.bytes ?? null, live_bytes: entry.bytes };
        }),
      } : {}),
      ...(report.missing.length > 0 ? { missing_scripts: report.missing.slice(0, limit) } : {}),
      ...(report.moved.length > 0 ? { moved_scripts: report.moved.slice(0, limit) } : {}),
      ...(report.not_script.length > 0 ? { not_a_script: report.not_script.slice(0, limit) } : {}),
      ...(report.unreadable.length > 0 ? { unreadable: report.unreadable.slice(0, limit) } : {}),
      ...(lists.some((list) => list.length > limit) ? { truncated: true } : {}),
    };
    if (role === 'edit') edit = checkOf(sent, report);
    else runtime.push(checkOf(sent, report));
  }

  const hints = syncHint(edit, runtime);
  if (movedTotal > 0) {
    hints.push(`${scripts(movedTotal, ['was', 'were'])} moved by game code, the way Cmdr moves its commands, and still match disk where they are now (moved_scripts).`);
  }
  if (unmatched.length > 0) {
    hints.push(`${unmatched.length} requested path(s) match no synced script, so they were not checked.`);
  } else if (selected.length === 0) {
    hints.push('The sourcemap maps no scripts in a place tree, so nothing was checked.');
  }
  if (goneFromDisk.length > 0) {
    hints.push(`The sourcemap lists ${goneFromDisk.length} file(s) no longer on disk${index.generatedFrom ? '' : ', so rerun with regenerate=true'}.`);
  }

  return toolText({
    all_in_sync: allInSync,
    sourcemap: {
      origin: index.generatedFrom ? 'rojo' : 'file',
      path: index.generatedFrom ?? index.sourcemapPath,
      age_s: Math.round((Date.now() - index.mtimeMs) / 1000),
      scripts: index.byPath.size,
      ...(map.rebuilt ? { rebuilt_because: map.stale } : {}),
      ...(map.error ? { stale_because: map.stale, rojo_error: map.error } : {}),
    },
    checked: expected.length,
    ...(selected.length > MAX_SCRIPTS ? { truncated: true, total_scripts: selected.length } : {}),
    ...(unmatched.length > 0 ? { unmatched_paths: unmatched.map(({ path }) => path) } : {}),
    ...(goneFromDisk.length > 0 ? { missing_on_disk: goneFromDisk.slice(0, limit), missing_on_disk_count: goneFromDisk.length } : {}),
    peers: results,
    ...(hints.length > 0 ? { hint: hints.join(' ') } : {}),
  });
}

export const syncFeature: ForkFeature = {
  name: 'sync',
  definitions: [
    {
      name: 'verify_sync',
      category: 'write',
      annotations: READ_ONLY_PROBE,
      description: 'Use when Studio ignores a file edit, to check whether each peer runs the source Rojo files hold on disk.',
      inputSchema: {
        type: 'object',
        properties: {
          project_root: { type: 'string', description: 'Rojo project folder, kept for later calls.' },
          paths: { type: 'array', items: { type: 'string' }, description: 'Studio paths to check with descendants, player copies too.' },
          peers: { type: 'string', description: 'all (default), edit, server or client-N.' },
          regenerate: { type: 'boolean', description: 'Rebuild the sourcemap with rojo even when it looks fresh.' },
          limit: { type: 'number', minimum: 1, maximum: 1000, default: 50, description: 'Scripts listed per category and peer.' },
          instance_id: { type: 'string', description: 'Studio process ID when ambiguous.' },
        },
      },
    },
  ],
  handlers: {
    verify_sync: (tools, body) => verifySync(tools.forkHost, body, body.instance_id as string | undefined),
  },
  instructions: [
    {
      tools: ['verify_sync'],
      text: 'When behaviour does not change after editing a synced file, run verify_sync before debugging the code.',
    },
  ],
  guide: `## Rojo sync

- Run verify_sync when behaviour did not change after editing a synced file, before debugging the code itself.
- It hashes every synced file on disk and compares it with the source each peer holds, reporting in_sync, stale and missing_in_studio per peer.
- Edit is read through the script editor, so open editor text counts, while server and clients read Script.Source of what they run, including a client's PlayerScripts, PlayerGui, Backpack and character copies.
- A loader that applies disk changes to playtests can leave edit Source behind on purpose, so stale in edit with matching server and clients means the running code is current.
- Stale at runtime means the playtest runs old code, so restart it once the sync has landed, and check the Rojo connection when edit is stale too.
- paths may name a runtime copy such as Players.<name>.PlayerScripts.Client, which selects the starter script it was copied from.
- all_in_sync is false when a requested path matches no synced script or nothing was checked, so read unmatched_paths and checked before trusting it.
- Clients never receive ServerScriptService or ServerStorage, and receive other server Scripts without their source, so those count as skipped_server_only there.
- A client copy that reads empty while its file is not is listed as unreadable, not stale, since a client may hold a script without its source.
- A script missing from its synced path is looked for by name elsewhere on that peer. A copy whose source matches disk is listed under moved_scripts and does not count against all_in_sync, which covers Cmdr moving its command modules. One still missing was destroyed or renamed by game code, or Rojo does not serve it.
- Line endings, a byte order mark and one final newline are ignored, so stale is a real content difference.
- A missing sourcemap.json, or one older than the project file or than ROBLOX_SOURCEMAP_MAX_AGE_S (300 by default), is rebuilt in memory with rojo sourcemap and never written into the project.
- Setting project_root starts that rebuild at once, and verify_sync waits for it.
- Pass regenerate=true after adding, renaming or moving files, since a map younger than that age is trusted.
- The rebuilt map also serves file:line annotations and the refusal to edit synced scripts in Studio.`,
};
