import * as fs from 'fs';
import * as path from 'path';
import { setTimeout as sleep } from 'timers/promises';
import { RoutingFailure } from '../../bridge-service.js';
import type { SourcemapResolver } from '../../sourcemap.js';
import type { ToolDefinition } from '../definitions.js';
import { clamp, luauValue, sourcemaps, toolText, type ForkHost } from '../fork-tools.js';
import type { ForkFeature } from './feature.js';

// Open Cloud Luau Execution: https://create.roblox.com/docs/cloud/reference/features/luau-execution
const API = 'https://apis.roblox.com/cloud/v2';
const MAX_SCRIPT_BYTES = 4 * 1024 * 1024;
const MAX_TIMEOUT_S = 300;
const TERMINAL = new Set(['COMPLETE', 'FAILED', 'CANCELLED']);
// The documented task path formats. task_path is caller supplied, and anything looser could aim the API key at another endpoint.
const TASK_PATH = /^universes\/\d+\/places\/\d+\/(?:versions\/\d+\/)?(?:luau-execution-session-tasks|luau-execution-sessions\/[\w-]+\/tasks)\/[\w-]+$/;
const MAX_LOG_CHARS = 100_000;
const MAX_LINE_CHARS = 2000;
const MAX_RESULT_CHARS = 60_000;
const MAX_ERRORS = 20;
const MAX_FAILURES = 50;
const MAX_SUMMARIES = 50;
// Roblox keeps at most 450 KB of logs and a page holds up to 10000 chunks, so a few pages always suffice.
const MAX_LOG_PAGES = 5;
const MAX_TRANSIENT_FAILURES = 5;

export const PLACE_IDS_LUAU = 'return { gameId = game.GameId, placeId = game.PlaceId }';

type Task = {
  path: string;
  state: string;
  error?: { code?: string; message?: string };
  output?: { results?: unknown[] };
};

type LogLine = { type: string; message: string };

type Backoff = { first: number; max: number };

export interface CloudLuauOptions {
  /** The connected Studio place, asked only when the IDs are not given. */
  studioPlace: () => Promise<{ universeId: number; placeId: number }>;
  signal?: AbortSignal;
  pollMs?: Backoff;
  /** Extra wait beyond timeout_s for queueing and server start. */
  graceMs?: number;
  /** Finds the Rojo project for script_file and annotates Studio paths in errors. */
  resolver?: SourcemapResolver;
}

const HINTS: Record<number, string> = {
  401: 'ROBLOX_OPEN_CLOUD_API_KEY was rejected',
  403: 'the key needs universe.place.luau-execution-session:write with this experience added, and must allow this IP',
  404: 'no such universe, place, version or task',
  429: 'rate limited, or ten tasks for this place are still unfinished',
};

class CloudError extends Error {
  constructor(readonly status: number, detail: string, action: string) {
    super(`${action} failed${status ? ` with HTTP ${status}` : ''}${HINTS[status] ? ` (${HINTS[status]})` : ''}: ${detail.slice(0, 300)}`);
  }

  get transient(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function cloud(url: string, action: string, key: string | undefined, signal?: AbortSignal, body?: unknown): Promise<Record<string, unknown>> {
  const timeout = AbortSignal.timeout(30_000);
  let response: Response;
  let raw: string;
  try {
    response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(key ? { 'x-api-key': key } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    // The body can still break off after the headers, from a reset socket or the timeout.
    raw = await response.text();
  } catch (error) {
    signal?.throwIfAborted();
    throw new CloudError(0, message(error), action);
  }
  if (!response.ok) throw new CloudError(response.status, raw, action);
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new CloudError(0, `non-JSON reply ${raw}`, action);
  }
}

async function retrying<T>(request: () => Promise<T>, backoff: Backoff, signal?: AbortSignal): Promise<T> {
  let delay = backoff.first;
  for (let failures = 1; ; failures++) {
    try {
      return await request();
    } catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof CloudError && error.transient) || failures >= MAX_TRANSIENT_FAILURES) throw error;
      await sleep(delay, undefined, { signal });
      delay = Math.min(delay * 2, backoff.max);
    }
  }
}

function clip(text: string): string {
  return text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text;
}

function positiveInt(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const number = typeof value === 'string' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`);
  return number;
}

function pattern(value: unknown, fallback: string, name: string): RegExp {
  try {
    return new RegExp(typeof value === 'string' && value !== '' ? value : fallback);
  } catch (error) {
    throw new Error(`${name} is not a valid regular expression: ${message(error)}`);
  }
}

// A project without sourcemap.json has no index until rojo builds one, so wait for that build instead of guessing a folder.
async function projectRoot(file: string, resolver: SourcemapResolver): Promise<string> {
  const current = resolver.current();
  if (current) return current.projectRoot;
  const map = await resolver.refresh();
  if (map.index) return map.index.projectRoot;
  throw new Error(`script_file ${file} is relative but no Rojo project was found (${map.error ?? 'no sourcemap'}). Pass an absolute path, or project_root to resolve_source first.`);
}

async function loadScript(body: Record<string, unknown>, resolver: SourcemapResolver): Promise<{ script: string; file?: string }> {
  const inline = typeof body.script === 'string' && body.script.trim() !== '' ? body.script : undefined;
  const file = typeof body.script_file === 'string' && body.script_file !== '' ? body.script_file : undefined;
  if ((inline === undefined) === (file === undefined)) throw new Error('Pass exactly one of script or script_file.');
  if (inline !== undefined) {
    if (Buffer.byteLength(inline) > MAX_SCRIPT_BYTES) throw new Error('script is over the 4 MB Open Cloud limit');
    return { script: inline };
  }
  const requested = path.isAbsolute(file!) ? file! : path.resolve(await projectRoot(file!, resolver), file!);
  let real: string;
  try {
    real = fs.realpathSync(requested);
  } catch {
    throw new Error(`script_file ${requested} does not exist`);
  }
  // The file is sent to Roblox, so only Luau sources qualify, never arbitrary local files.
  if (!/\.luau?$/i.test(real)) throw new Error(`script_file must be a .luau or .lua file, got ${real}`);
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw new Error(`script_file ${real} is not a file`);
  if (stat.size > MAX_SCRIPT_BYTES) throw new Error(`script_file ${real} is over the 4 MB Open Cloud limit`);
  return { script: fs.readFileSync(real, 'utf8'), file: real };
}

async function universeOf(placeId: number, signal?: AbortSignal): Promise<number> {
  const reply = await cloud(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`, 'Looking up the universe', undefined, signal);
  const universeId = Number(reply.universeId);
  if (!universeId) throw new Error(`Place ${placeId} has no universe. Check place_id or pass universe_id.`);
  return universeId;
}

async function resolvePlace(body: Record<string, unknown>, options: CloudLuauOptions): Promise<{ universeId: number; placeId: number }> {
  const universeId = positiveInt(body.universe_id, 'universe_id');
  const placeId = positiveInt(body.place_id, 'place_id');
  if (universeId !== undefined && placeId !== undefined) return { universeId, placeId };
  if (placeId !== undefined) return { universeId: await universeOf(placeId, options.signal), placeId };
  const open = await options.studioPlace();
  if (!open.universeId || !open.placeId) throw new Error('The open place is unpublished. Publish it, or pass universe_id and place_id.');
  if (universeId !== undefined && universeId !== open.universeId) {
    throw new Error(`The open place belongs to universe ${open.universeId}, not ${universeId}. Pass place_id.`);
  }
  return open;
}

/** Universe and place of the connected Studio place, read on its edit peer. */
export async function studioPlace(host: ForkHost, instanceId: string | undefined): Promise<{ universeId: number; placeId: number }> {
  let peers;
  try {
    peers = await host.peerTargets('edit', instanceId);
  } catch (error) {
    if (error instanceof RoutingFailure) {
      throw new RoutingFailure({ ...error.routingError, message: `${error.routingError.message} Pass universe_id and place_id to skip Studio.` });
    }
    throw error;
  }
  if (peers.length !== 1) throw new Error(`${peers.length} edit peers matched. Pass instance_id, or universe_id and place_id.`);
  const ids = luauValue(await host.requestPeer('/api/execute-luau', { code: PLACE_IDS_LUAU }, peers[0].peerId, 15_000));
  return { universeId: Number(ids.gameId) || 0, placeId: Number(ids.placeId) || 0 };
}

/** The lines read so far, with why reading stopped early when it did. */
async function readLogs(taskPath: string, key: string, backoff: Backoff, signal?: AbortSignal): Promise<{ lines: LogLine[]; error?: string; capped?: boolean }> {
  const lines: LogLine[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_LOG_PAGES; page++) {
    const url = new URL(`${API}/${taskPath}/logs`);
    url.searchParams.set('view', 'STRUCTURED');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    let reply: Record<string, unknown>;
    try {
      reply = await retrying(() => cloud(url.toString(), 'Reading task logs', key, signal), backoff, signal);
    } catch (error) {
      signal?.throwIfAborted();
      return { lines, error: message(error) };
    }
    for (const chunk of (reply.luauExecutionSessionTaskLogs as Array<Record<string, unknown>>) ?? []) {
      const structured = chunk.structuredMessages as Array<{ message?: unknown; messageType?: unknown }> | undefined;
      const flat = (chunk.messages as unknown[] | undefined)?.map((text) => ({ message: text, messageType: 'OUTPUT' }));
      for (const entry of structured ?? flat ?? []) {
        lines.push({ type: typeof entry.messageType === 'string' ? entry.messageType : 'OUTPUT', message: String(entry.message ?? '') });
      }
    }
    pageToken = typeof reply.nextPageToken === 'string' && reply.nextPageToken !== '' ? reply.nextPageToken : undefined;
    if (!pageToken) return { lines };
  }
  return { lines, capped: true };
}

function summarize(lines: LogLine[], summary: RegExp, failLine: RegExp, maxLines: number, resolver: SourcemapResolver) {
  // Annotation reads the sourcemap per call, so only the lines that are returned get it.
  const annotate = (text: string) => resolver.annotateText(clip(text));
  const summaries = lines.map((line) => summary.exec(line.message)).filter((match): match is RegExpExecArray => match !== null);
  const failures = lines.map((line) => failLine.exec(line.message)).filter((match): match is RegExpExecArray => match !== null);
  const errors = lines.filter((line) => line.type === 'ERROR' && !failLine.test(line.message));
  const shown = lines.slice(-maxLines).map((line) => annotate(line.type === 'OUTPUT' ? line.message : `[${line.type}] ${line.message}`));
  let chars = shown.reduce((total, line) => total + line.length, 0);
  while (chars > MAX_LOG_CHARS && shown.length > 1) chars -= shown.shift()!.length;
  return {
    ...(summaries.length > 0 ? {
      summaries: summaries.slice(-MAX_SUMMARIES).map((match) => clip(match[0])),
      ...(summaries.length > MAX_SUMMARIES ? { summariesTruncated: true } : {}),
      passed: summaries.reduce((total, match) => total + (Number(match[1] ?? 0) || 0), 0),
      failed: summaries.reduce((total, match) => total + (Number(match[2] ?? 0) || 0), 0),
      failures: failures.slice(0, MAX_FAILURES).map((match) => annotate(match[1] ?? match[0])),
      ...(failures.length > MAX_FAILURES ? { failuresTruncated: true } : {}),
    } : {}),
    ...(errors.length > 0 ? {
      errors: errors.slice(0, MAX_ERRORS).map((line) => annotate(line.message)),
      ...(errors.length > MAX_ERRORS ? { errorsTruncated: true } : {}),
    } : {}),
    logs: shown,
    ...(shown.length < lines.length ? { logsTruncated: true, totalLogLines: lines.length } : {}),
  };
}

export async function runCloudLuau(body: Record<string, unknown>, options: CloudLuauOptions): Promise<Record<string, unknown>> {
  const key = process.env.ROBLOX_OPEN_CLOUD_API_KEY?.trim();
  if (!key) {
    throw new Error('cloud_luau needs ROBLOX_OPEN_CLOUD_API_KEY with the universe.place.luau-execution-session:write scope for the experience.');
  }
  const timeoutS = clamp(body.timeout_s, 120, 1, MAX_TIMEOUT_S);
  const summary = pattern(body.summary_pattern, '(\\d+) passed, (\\d+) failed', 'summary_pattern');
  const failLine = pattern(body.fail_pattern, '\\bFAIL\\b\\s*(.*)', 'fail_pattern');
  const maxLines = clamp(body.max_log_lines, 200, 1, 2000);
  const { signal } = options;
  const resolver = options.resolver ?? sourcemaps;
  const started = Date.now();

  let task: Task;
  let file: string | undefined;
  const resumed = typeof body.task_path === 'string' && body.task_path !== '';
  if (resumed) {
    if (!TASK_PATH.test(body.task_path as string)) throw new Error('task_path must be a taskPath returned by an earlier call.');
    task = { path: body.task_path as string, state: 'UNKNOWN' };
  } else {
    const loaded = await loadScript(body, resolver);
    file = loaded.file;
    const { universeId, placeId } = await resolvePlace(body, options);
    const version = positiveInt(body.place_version, 'place_version');
    const url = `${API}/universes/${universeId}/places/${placeId}/${version ? `versions/${version}/` : ''}luau-execution-session-tasks`;
    task = await cloud(url, 'Creating the task', key, signal, { script: loaded.script, timeout: `${timeoutS}s` }) as Task;
    if (typeof task.path !== 'string' || !TASK_PATH.test(task.path)) {
      throw new Error(`Open Cloud returned an unexpected task: ${JSON.stringify(task).slice(0, 300)}`);
    }
  }

  const poll = options.pollMs ?? { first: 1000, max: 5000 };
  const deadline = started + timeoutS * 1000 + (options.graceMs ?? 60_000);
  let delay = resumed ? 0 : poll.first;
  let failures = 0;
  while (!TERMINAL.has(task.state) && Date.now() < deadline) {
    await sleep(Math.min(delay, Math.max(0, deadline - Date.now())), undefined, { signal });
    delay = Math.min(Math.max(delay * 1.5, poll.first), poll.max);
    try {
      task = { ...task, ...await cloud(`${API}/${task.path}`, 'Polling the task', key, signal) };
      failures = 0;
    } catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof CloudError && error.transient) || ++failures >= MAX_TRANSIENT_FAILURES) {
        throw new Error(`${message(error)} (task ${task.path} may still be running)`);
      }
    }
  }

  const elapsedS = Math.round((Date.now() - started) / 1000);
  const base = { state: task.state, taskPath: task.path, ...(file ? { scriptFile: file } : {}), elapsedS };
  if (!TERMINAL.has(task.state)) {
    return {
      ...base,
      timedOut: true,
      note: `Still ${task.state} after ${elapsedS}s. The task keeps running on Roblox. Pass this taskPath as task_path to keep waiting.`,
    };
  }

  const results = task.output?.results ?? [];
  const serialized = JSON.stringify(results);
  const read = await readLogs(task.path, key, poll, signal);
  return {
    ...base,
    ...(task.error ? { error: { code: task.error.code, message: resolver.annotateText(clip(String(task.error.message ?? ''))) } } : {}),
    ...(serialized.length > MAX_RESULT_CHARS ? { results: `${serialized.slice(0, MAX_RESULT_CHARS)}…`, resultsTruncated: true } : { results }),
    ...summarize(read.lines, summary, failLine, maxLines, resolver),
    ...(read.error || read.capped ? { logsIncomplete: true } : {}),
    ...(read.error ? {
      logsError: read.error,
      note: 'Counts and logs cover only the lines read. Pass this taskPath as task_path within 24 hours to read the logs again.',
    } : {}),
  };
}

const definitions: ToolDefinition[] = [
  {
    name: 'cloud_luau',
    category: 'write',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    description: 'Use to run Luau headlessly on a Roblox cloud server against the published place, such as tests without Studio.',
    inputSchema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'Luau source to run, its return values come back as JSON.' },
        script_file: { type: 'string', description: 'Local .luau file to run instead, absolute or project relative.' },
        task_path: { type: 'string', description: 'taskPath of an earlier call to keep waiting on.' },
        universe_id: { type: 'number', description: "Universe ID, defaults to the open place's game." },
        place_id: { type: 'number', description: 'Place ID, defaults to the open place.' },
        place_version: { type: 'number', description: 'Saved place version, defaults to the latest.' },
        timeout_s: { type: 'number', minimum: 1, maximum: MAX_TIMEOUT_S, default: 120, description: 'Script time limit in seconds.' },
        summary_pattern: { type: 'string', description: 'Regex with passed and failed groups.' },
        fail_pattern: { type: 'string', description: 'Regex for a failure line, group 1 is kept.' },
        max_log_lines: { type: 'number', minimum: 1, maximum: 2000, default: 200, description: 'Log lines returned, newest kept.' },
        instance_id: { type: 'string', description: 'Studio process ID when ambiguous.' },
      },
    },
  },
];

const guide = `
## Cloud Luau execution

- cloud_luau runs a script on a fresh Roblox game server through the Open Cloud Luau Execution API, so no Studio session or playtest is needed.
- Reference: https://create.roblox.com/docs/cloud/reference/features/luau-execution and the CI example https://github.com/Roblox/place-ci-cd-demo.
- ROBLOX_OPEN_CLOUD_API_KEY needs the universe.place.luau-execution-session:write scope with the experience added to the key.
- The task loads the place's latest version on Roblox, or place_version, never unsaved Studio edits, so save or publish before testing a change.
- Physics does not run and Scripts and LocalScripts in the place do not start, so require the ModuleScripts under test from the script.
- DataModel changes are discarded when the task ends, but DataStores and other cloud APIs act on live data, and AssetService:SavePlaceAsync can save the place.
- Values the script returns come back in results as JSON, and Instances or other values JSON cannot hold become null.
- Without universe_id and place_id the connected Studio place is used, and place_id alone looks up its universe.
- An unpublished place has no IDs, so publish it first.
- script_file reads a local .luau or .lua file, and a relative path is taken from the Rojo project folder that resolve_source uses.
- A relative script_file is refused when no Rojo project is found, so pass an absolute path or set project_root with resolve_source.
- summary_pattern and fail_pattern are matched against the printed log lines.
- passed and failed add up every summary line, and failures appear only when a summary line matched.
- Log lines, errors, failures and the error message are cut at 2000 characters.
- errors keeps the first 20, failures the first 50 and summaries the last 50, with errorsTruncated, failuresTruncated or summariesTruncated set when more matched.
- When reading the logs fails after retries, logsIncomplete and logsError are set and the counts cover only the lines read.
- Then pass the same taskPath as task_path to read the logs again without running the script again.
- Limits: scripts up to 4 MB, at most 5 minutes (timeout_s up to 300), 4 MB of JSON return values, 450 KB of logs with the oldest dropped first.
- Roblox allows 5 task creations per minute per key owner and 10 unfinished tasks per place, and answers HTTP 429 beyond that.
- If the wait ends before the task does, the task keeps running on Roblox.
- Pass the returned taskPath as task_path to keep waiting instead of starting another task.
- Task details and logs stay readable for 24 hours after the task finishes.
`;

export const cloudFeature: ForkFeature = {
  name: 'cloud',
  definitions,
  handlers: {
    cloud_luau: async (tools, body, context) => toolText(await runCloudLuau(body, {
      studioPlace: () => studioPlace(tools.forkHost, body.instance_id as string | undefined),
      signal: context?.signal,
    })),
  },
  instructions: [
    {
      tools: ['cloud_luau'],
      text: 'Use cloud_luau to run tests or server logic on a Roblox cloud server against the saved place when Studio is not needed. It never sees unsaved Studio edits.',
    },
  ],
  guide,
};
