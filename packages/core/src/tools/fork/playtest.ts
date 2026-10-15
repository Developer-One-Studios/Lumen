import type { ToolDefinition } from '../definitions.js';
import type { RobloxStudioTools } from '../index.js';
import { clamp, luauValue, parseResult, sourcemaps, toolText, wait, type ForkHost, type PeerTarget } from '../fork-tools.js';
import type { ForkFeature, ForkToolResult } from './feature.js';
import {
  ERROR_SAMPLE,
  NIL_SAMPLE,
  conditionLuau,
  explainLuauError,
  runLuau,
  userFunction,
  watchLuau,
  type LuauChunk,
  type UserFunction,
} from './playtest-luau.js';

const EXECUTE = '/api/execute-luau';
const EVAL = '/api/eval-runtime';
const RUNTIME_LOGS = '/api/get-runtime-logs';

const MAX_STEPS = 100;
const MAX_SCREENSHOTS = 10;
const MAX_RECORDINGS = 4;
const MAX_RECORD_S = 30;
const MAX_SAMPLES = 600;
const MAX_EXPRESSIONS = 10;
const MAX_LOG_GROUPS = 25;
// Matches the aggregate inline budget capture_screenshot gives a multi-image call.
const IMAGE_BUDGET_BYTES = 8_000_000;
const DEFAULT_MAX_WIDTH = 1280;
// An expect checks once, so a check that yields (InvokeServer) needs its own allowance.
const EXPECT_YIELD_S = 5;
// Errors raised by the last step reach the log buffers a moment after it returns.
const LOG_SETTLE_MS = 300;
// Each peer keeps about 64 KiB of log text, so long scenarios read it before it wraps.
const LOG_DRAIN_MS = 1000;

type Vm = 'plugin' | 'game';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Like clamp, but keeps fractions for second-based arguments. */
function seconds(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, number));
}

function vmOf(value: unknown): Vm {
  if (value === undefined || value === 'plugin') return 'plugin';
  if (value === 'game') return 'game';
  throw new Error(`vm must be plugin or game, got ${String(value)}`);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

async function playtestRunning(host: ForkHost, instanceId: string | undefined): Promise<boolean> {
  return (await host.peerTargets('all', instanceId)).some((peer) => peer.role !== 'edit');
}

/** The named peer, else the server while a playtest runs, else edit. */
async function codePeer(host: ForkHost, peer: unknown, instanceId: string | undefined): Promise<PeerTarget> {
  if (nonEmpty(peer)) {
    const peers = await host.peerTargets(peer, instanceId);
    if (peers.length !== 1) throw new Error(`peer must name one peer, ${peers.length} matched`);
    return peers[0];
  }
  const peers = await host.peerTargets('all', instanceId);
  const chosen = peers.find((entry) => entry.role === 'server') ?? peers.find((entry) => entry.role === 'edit');
  if (!chosen) throw new Error('No server or edit peer is connected, pass peer.');
  return chosen;
}

/** Maps chunk locations in Luau error text to the caller's own label and line, then to Rojo files. */
function explainer(chunk: LuauChunk): (text: string) => string {
  return (text) => sourcemaps.annotateText(explainLuauError(text, chunk.ranges));
}

async function runChunk(host: ForkHost, peer: PeerTarget, vm: Vm, chunk: LuauChunk, timeoutMs: number): Promise<Record<string, unknown>> {
  if (vm === 'game' && peer.role === 'edit') throw new Error('vm=game needs a playtest peer. Start a playtest or use vm=plugin.');
  const reply = await host.requestPeer(vm === 'game' ? EVAL : EXECUTE, { code: chunk.code }, peer.peerId, timeoutMs);
  try {
    return luauValue(reply);
  } catch (error) {
    throw new Error(explainer(chunk)(errorText(error)));
  }
}

type ProbeOptions = { peer?: unknown; vm?: unknown; timeout_s?: unknown; interval_ms?: unknown };

async function poll(
  host: ForkHost,
  condition: UserFunction,
  options: ProbeOptions,
  instanceId: string | undefined,
  yieldS?: number,
): Promise<Record<string, unknown>> {
  const timeoutS = seconds(options.timeout_s, 10, 0, 120);
  const allowanceS = yieldS ?? timeoutS;
  const vm = vmOf(options.vm);
  const peer = await codePeer(host, options.peer, instanceId);
  const chunk = conditionLuau(condition, { timeout_s: timeoutS, interval_ms: clamp(options.interval_ms, 100, 16, 10_000), yield_s: allowanceS });
  const result = await runChunk(host, peer, vm, chunk, Math.max(timeoutS, allowanceS) * 1000 + 15_000);
  if (typeof result.last_error === 'string') result.last_error = explainer(chunk)(result.last_error);
  return { peer: peer.role, vm, ...result };
}

export async function waitForCondition(host: ForkHost, options: ProbeOptions & { condition?: unknown }, instanceId: string | undefined) {
  if (!nonEmpty(options.condition)) throw new Error('condition must be a Luau expression or a body that returns');
  return poll(host, userFunction('condition', options.condition), options, instanceId);
}

/** Runs caller statements once. value is present only when they returned something. */
export async function runCode(host: ForkHost, options: ProbeOptions & { code: string }, instanceId: string | undefined): Promise<{ value?: unknown }> {
  const vm = vmOf(options.vm);
  const peer = await codePeer(host, options.peer, instanceId);
  const timeoutS = seconds(options.timeout_s, 30, 1, 300);
  const result = await runChunk(host, peer, vm, runLuau(userFunction('run', options.code, 'body')), timeoutS * 1000 + 5_000);
  return result.returned === true ? { value: result.value ?? null } : {};
}

type LogLine = { role: string; level: string; message: string };

/**
 * Reads only lines logged after begin(), across every peer (or only), including peers that join later.
 * Routing errors propagate, so a missing peer or an ambiguous Studio fails instead of reading nothing.
 */
export class LogWatch {
  private readonly cursors = new Map<string, number>();
  private readonly since = Date.now() / 1000;

  constructor(private readonly host: ForkHost, private readonly instanceId: string | undefined, private readonly only?: string) {}

  private async query(peer: PeerTarget, data: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    try {
      const reply = await this.host.requestPeer(RUNTIME_LOGS, data, peer.peerId, 15_000);
      return record(reply);
    } catch {
      // A peer that left mid-read (a stopping playtest) has nothing more to report.
      return undefined;
    }
  }

  async begin(): Promise<void> {
    await Promise.all((await this.host.peerTargets(this.only ?? 'all', this.instanceId)).map(async (peer) => {
      const reply = await this.query(peer, { tail: 0 });
      if (typeof reply?.nextSince === 'number') this.cursors.set(peer.peerId, reply.nextSince);
    }));
  }

  async read(): Promise<LogLine[]> {
    const batches = await Promise.all((await this.host.peerTargets(this.only ?? 'all', this.instanceId)).map(async (peer) => {
      const since = this.cursors.get(peer.peerId);
      const reply = await this.query(peer, since === undefined ? {} : { since });
      if (!reply || !Array.isArray(reply.entries)) return [];
      if (typeof reply.nextSince === 'number') this.cursors.set(peer.peerId, reply.nextSince);
      // A peer that joined after begin (a playtest this call started) is read from its first line within this call.
      return (reply.entries as Array<Record<string, unknown>>)
        .filter((entry) => since !== undefined || (typeof entry.ts === 'number' && entry.ts >= this.since - 1))
        .map((entry) => ({ role: peer.role, level: String(entry.level), message: String(entry.message) }));
    }));
    return batches.flat();
  }
}

function logMatcher(pattern: string): (text: string) => boolean {
  const literal = /^\/(.+)\/([a-z]*)$/s.exec(pattern);
  if (!literal) return (text) => text.includes(pattern);
  let regex: RegExp;
  try {
    regex = new RegExp(literal[1], literal[2]);
  } catch (error) {
    throw new Error(`log is not a valid regex: ${errorText(error)}`);
  }
  return (text) => {
    regex.lastIndex = 0;
    return regex.test(text);
  };
}

export async function waitForLog(
  host: ForkHost,
  options: { log: string; peer?: unknown; timeout_s?: unknown; interval_ms?: unknown },
  instanceId: string | undefined,
  signal?: AbortSignal,
) {
  const matches = logMatcher(options.log);
  const timeoutMs = seconds(options.timeout_s, 10, 0, 120) * 1000;
  // Every poll is a round trip per peer, so log polls are spaced wider than Luau ones.
  const intervalMs = Math.max(250, clamp(options.interval_ms, 100, 16, 10_000));
  const logs = new LogWatch(host, instanceId, nonEmpty(options.peer) ? options.peer : undefined);
  await logs.begin();
  const started = Date.now();
  const elapsed = () => (Date.now() - started) / 1000;
  for (let polls = 1; ; polls++) {
    const hit = (await logs.read()).find((line) => matches(line.message));
    if (hit) return { met: true, elapsed_s: elapsed(), polls, value: sourcemaps.annotateText(hit.message), peer: hit.role, level: hit.level };
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0 || signal?.aborted) return { met: false, elapsed_s: elapsed(), polls };
    await wait(Math.min(intervalMs, remaining));
  }
}

function watchEntries(expressions: unknown): Array<[string, string]> {
  const map = record(expressions);
  if (!map) throw new Error('expressions must map names to Luau expressions');
  const entries = Object.entries(map);
  if (entries.length === 0 || entries.length > MAX_EXPRESSIONS) throw new Error(`expressions needs 1 to ${MAX_EXPRESSIONS} entries`);
  for (const [name, source] of entries) {
    if (!nonEmpty(source)) throw new Error(`expression ${name} must be a non-empty Luau string`);
  }
  return entries as Array<[string, string]>;
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

function isVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'number');
}

function summarize(values: unknown[]): Record<string, unknown> {
  const present = values.filter((value) => value !== null);
  if (present.length === 0) return { first: null, last: null };
  const first = present[0];
  const last = present[present.length - 1];
  if (present.every((value) => typeof value === 'number')) {
    const numbers = present as number[];
    return { first, last, min: Math.min(...numbers), max: Math.max(...numbers), delta: round3((last as number) - (first as number)) };
  }
  if (present.every(isVector) && (first as number[]).length === (last as number[]).length) {
    return { first, last, delta: (last as number[]).map((value, index) => round3(value - (first as number[])[index])) };
  }
  let changes = 0;
  for (let index = 1; index < present.length; index++) {
    if (JSON.stringify(present[index]) !== JSON.stringify(present[index - 1])) changes++;
  }
  return { first, last, changes };
}

/** Turns raw watch samples into series with summaries, keeping at most maxSamples evenly spaced samples. */
export function shapeSamples(raw: Record<string, unknown>, maxSamples = MAX_SAMPLES, explain: (text: string) => string = sourcemaps.annotateText.bind(sourcemaps)) {
  const times = Array.isArray(raw.t) ? raw.t as number[] : [];
  // JSONEncode writes an empty table as [], so only a real object holds columns.
  const columns = (value: unknown) => record(value) ?? {};
  const clean = (values: unknown) => (Array.isArray(values) ? values.map((value) => (value === NIL_SAMPLE || value === ERROR_SAMPLE ? null : value)) : []);
  const magnitudes = columns(raw.magnitudes);
  const full: Record<string, unknown[]> = {};
  for (const [name, values] of Object.entries(columns(raw.series))) {
    full[name] = clean(values);
    if (magnitudes[name] !== undefined) full[`${name}.magnitude`] = clean(magnitudes[name]);
  }
  const picked = times.length > maxSamples
    ? Array.from({ length: maxSamples }, (_, index) => Math.round((index * (times.length - 1)) / (maxSamples - 1)))
    : undefined;
  const pick = <T>(values: T[]) => (picked ? picked.map((index) => values[index]) : values);
  const errors = Object.fromEntries(Object.entries(columns(raw.errors)).map(([name, error]) => {
    const entry = record(error);
    return [name, entry && typeof entry.first === 'string' ? { ...entry, first: explain(entry.first) } : error];
  }));
  return {
    samples: times.length,
    t: pick(times),
    series: Object.fromEntries(Object.entries(full).map(([name, values]) => [name, pick(values)])),
    summary: Object.fromEntries(Object.entries(full).map(([name, values]) => [name, summarize(values)])),
    ...(picked ? { decimated: { from: times.length, to: maxSamples, note: 'Evenly spaced samples kept, the summary uses every sample.' } } : {}),
    ...(Object.keys(errors).length > 0 ? { errors } : {}),
    ...(typeof raw.action_error === 'string' ? { action_error: explain(raw.action_error) } : {}),
  };
}

export async function watchValues(
  host: ForkHost,
  options: ProbeOptions & { expressions?: unknown; duration_ms?: unknown; action?: unknown },
  instanceId: string | undefined,
) {
  const entries = watchEntries(options.expressions);
  const durationMs = clamp(options.duration_ms, 3000, 100, 30_000);
  const intervalMs = clamp(options.interval_ms, 100, 16, 5000);
  const vm = vmOf(options.vm);
  const peer = await codePeer(host, options.peer, instanceId);
  const chunk = watchLuau(
    entries.map(([name, source]) => userFunction(name, source)),
    nonEmpty(options.action) ? userFunction('action', options.action, 'body') : undefined,
    { names: entries.map(([name]) => name), duration_ms: durationMs, interval_ms: intervalMs },
  );
  const raw = await runChunk(host, peer, vm, chunk, durationMs + 30_000);
  return { peer: peer.role, vm, interval_ms: intervalMs, ...shapeSamples(raw, MAX_SAMPLES, explainer(chunk)) };
}

const STEP_KINDS = ['key', 'text', 'click', 'wait', 'wait_for', 'walk_to', 'run', 'expect', 'screenshot', 'watch', 'record'] as const;
type StepKind = typeof STEP_KINDS[number];
type Step = { kind: StepKind; arg: unknown; options: Record<string, unknown> };
type WalkGoal = { path: string } | { position: { x: number; y: number; z: number } };

function isPoint(value: unknown, axes: string[]): boolean {
  const point = record(value);
  return point !== undefined && axes.every((name) => typeof point[name] === 'number' && Number.isFinite(point[name]));
}

/** Names what stopped a walk, so a failed step points at the blocking part instead of only the distance left. */
function walkError(result: Record<string, unknown>): string {
  const blocked = result.blocked as { waypoint?: unknown; by?: { path?: unknown } } | undefined;
  const where = `${String(result.distance)} studs from the goal`;
  if (blocked) {
    const by = typeof blocked.by?.path === 'string' ? ` by ${blocked.by.path}` : '';
    const at = typeof blocked.waypoint === 'number' ? ` at waypoint ${blocked.waypoint}` : '';
    return `blocked${by}${at}, ${where}`;
  }
  return typeof result.stopped === 'string' ? `${result.stopped}, ${where}` : `stopped ${where}`;
}

/** walk_to takes an instance path, {path}, {position: {x, y, z}} or a bare {x, y, z}. */
function walkGoal(arg: unknown): WalkGoal | undefined {
  if (nonEmpty(arg)) return { path: arg };
  const goal = record(arg);
  if (!goal) return undefined;
  if (nonEmpty(goal.path)) return { path: goal.path };
  const point = record(goal.position) ?? goal;
  return isPoint(point, ['x', 'y', 'z']) ? { position: { x: point.x as number, y: point.y as number, z: point.z as number } } : undefined;
}

function stepProblem(kind: StepKind, arg: unknown): string | undefined {
  switch (kind) {
    case 'wait':
      return typeof arg === 'number' && Number.isFinite(arg) && arg >= 0 ? undefined : 'needs a number of seconds';
    case 'record':
      return typeof arg === 'number' && Number.isFinite(arg) && arg >= 0.5 && arg <= MAX_RECORD_S
        ? undefined
        : `needs a number of seconds from 0.5 to ${MAX_RECORD_S}`;
    case 'click':
      return nonEmpty(arg) || isPoint(arg, ['x', 'y']) ? undefined : 'needs a GuiObject path or {x, y}';
    case 'walk_to':
      return walkGoal(arg) ? undefined : 'needs an instance path, {path}, {position: {x, y, z}} or {x, y, z}';
    case 'watch':
      try {
        watchEntries(arg);
        return undefined;
      } catch (error) {
        return errorText(error);
      }
    case 'text':
      return typeof arg === 'string' ? undefined : 'needs a string';
    default:
      return nonEmpty(arg) ? undefined : 'needs a non-empty string';
  }
}

export function parseSteps(raw: unknown): Step[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('steps must be a non-empty array');
  if (raw.length > MAX_STEPS) throw new Error(`steps holds at most ${MAX_STEPS} entries`);
  const steps = raw.map((entry, index): Step => {
    const options = record(entry);
    if (!options) throw new Error(`step ${index + 1} must be an object`);
    const kinds = STEP_KINDS.filter((kind) => options[kind] !== undefined);
    if (kinds.length !== 1) {
      throw new Error(`step ${index + 1} needs exactly one of ${STEP_KINDS.join(', ')}, found ${kinds.length === 0 ? 'none' : kinds.join(' and ')}`);
    }
    const problem = stepProblem(kinds[0], options[kinds[0]]);
    if (problem) throw new Error(`step ${index + 1} (${kinds[0]}) ${problem}`);
    return { kind: kinds[0], arg: options[kinds[0]], options };
  });
  if (steps.filter((step) => step.kind === 'screenshot').length > MAX_SCREENSHOTS) {
    throw new Error(`a scenario takes at most ${MAX_SCREENSHOTS} screenshots`);
  }
  if (steps.filter((step) => step.kind === 'record').length > MAX_RECORDINGS) {
    throw new Error(`a scenario takes at most ${MAX_RECORDINGS} record steps`);
  }
  return steps;
}

type StepOutcome = { value?: unknown; error?: string };

interface Scenario {
  tools: RobloxStudioTools;
  instanceId: string | undefined;
  client: string;
  quality: number;
  maxWidth: number;
  images: ForkToolResult['content'];
  imageBytes: number;
  screenshots: Array<Record<string, unknown>>;
}

/** simulate_* replies carry the plugin's own {error} or {success:false} rather than throwing. */
function inputOutcome(result: { content: Array<{ type: string; text?: string }> }): StepOutcome {
  const reply = parseResult(result);
  if (typeof reply.error === 'string') return { error: typeof reply.message === 'string' ? `${reply.error}: ${reply.message}` : reply.error };
  if (reply.success === false) return { error: String(reply.message ?? 'input was not delivered') };
  return {};
}

async function screenshot(scenario: Scenario, label: string, index: number, client: string, chosen: boolean): Promise<StepOutcome> {
  const { tools, instanceId } = scenario;
  // Input steps drive client, so the image must come from that client for its coordinates to apply.
  const fromClient = chosen || (await tools.forkHost.peerTargets('all', instanceId)).some((peer) => /^client-\d+$/.test(peer.role));
  const options = { max_width: scenario.maxWidth, ...(fromClient ? { clients: [client] } : {}) };
  const capture: ForkToolResult = await tools.fork.serializeCapture(() => tools.captureScreenshot(instanceId, 'jpeg', scenario.quality, options));
  const reply = parseResult(capture);
  // With clients the summary lists each image under images[], otherwise its fields are the reply itself.
  const shot = (Array.isArray(reply.images) ? record(reply.images[0]) : undefined) ?? reply;
  const image = capture.content.find((item) => item.type === 'image' && typeof item.data === 'string');
  if (!image?.data) return { error: String(shot.error ?? reply.error ?? 'the capture returned no image') };
  const bytes = Math.ceil((image.data.length * 3) / 4);
  if (scenario.imageBytes + bytes > IMAGE_BUDGET_BYTES) {
    const used = (scenario.imageBytes / 1_000_000).toFixed(1);
    return { error: `this ${(bytes / 1_000_000).toFixed(1)} MB image would pass the 8 MB screenshot budget (${used} MB used), lower quality or max_width` };
  }
  scenario.imageBytes += bytes;
  scenario.images.push({ type: 'image', data: image.data, mimeType: image.mimeType });
  const number = scenario.images.length;
  scenario.screenshots.push({
    label,
    step: index,
    image: number,
    width: shot.width,
    height: shot.height,
    ...(shot.scale !== undefined ? { scale: shot.scale } : {}),
    ...(typeof shot.client === 'string' ? { client: shot.client } : {}),
  });
  return { value: { label, image: number } };
}

/** Records the viewport like record_viewport and adds its grid to the report's images, under the same budget. */
async function recordStep(scenario: Scenario, step: Step, index: number): Promise<StepOutcome> {
  const { tools, instanceId } = scenario;
  const { options } = step;
  const capture: ForkToolResult = await tools.fork.serializeCapture(() => tools.recordViewport(instanceId, {
    duration_s: step.arg,
    fps: options.fps,
    frame_width: options.frame_width,
    sheet_frames: options.sheet_frames,
    stamp: options.stamp,
  }));
  const summary = parseResult(capture);
  const image = capture.content.find((item) => item.type === 'image' && typeof item.data === 'string');
  if (!image?.data) return { value: summary, error: String(summary.error ?? 'the recording returned no grid') };
  const bytes = Math.ceil((image.data.length * 3) / 4);
  if (scenario.imageBytes + bytes > IMAGE_BUDGET_BYTES) {
    return { value: summary, error: `this ${(bytes / 1_000_000).toFixed(1)} MB grid would pass the 8 MB image budget, lower sheet_frames or frame_width` };
  }
  scenario.imageBytes += bytes;
  scenario.images.push({ type: 'image', data: image.data, mimeType: image.mimeType });
  const label = nonEmpty(options.label) ? options.label : `record ${index}`;
  scenario.screenshots.push({ label, step: index, image: scenario.images.length, recording: true });
  return { value: { ...summary, image: scenario.images.length } };
}

async function runStep(scenario: Scenario, step: Step, index: number): Promise<StepOutcome> {
  const { tools, instanceId } = scenario;
  const { options } = step;
  const client = nonEmpty(options.client) ? options.client : scenario.client;
  const probe = { peer: options.peer, vm: options.vm, timeout_s: options.timeout_s, interval_ms: options.interval_ms };
  switch (step.kind) {
    case 'key':
      return inputOutcome(await tools.simulateKeyboardInput(step.arg as string, 'tap', seconds(options.hold_s, 0.1, 0, 10), undefined, client, instanceId));
    case 'text':
      return inputOutcome(await tools.simulateKeyboardInput(undefined, undefined, undefined, step.arg as string, client, instanceId));
    case 'click': {
      const point = typeof step.arg === 'string'
        ? await tools.fork.guiCenter(step.arg, client, instanceId)
        : step.arg as { x: number; y: number };
      const outcome = inputOutcome(await tools.simulateMouseInput('click', point.x, point.y, 'Left', undefined, client, instanceId));
      return outcome.error ? outcome : { value: { x: point.x, y: point.y } };
    }
    case 'wait':
      await wait(seconds(step.arg, 0, 0, 300) * 1000);
      return {};
    case 'wait_for': {
      const result = await waitForCondition(tools.forkHost, { ...probe, condition: step.arg }, instanceId);
      if (result.met === true) return { value: result };
      const last = typeof result.last_error === 'string' ? `, last error: ${result.last_error}` : '';
      return { value: result, error: `not met after ${String(result.elapsed_s)}s${last}` };
    }
    case 'walk_to': {
      const result = parseResult(await tools.fork.navigateCharacter({ ...walkGoal(step.arg), timeout_s: options.timeout_s, target: client, instance_id: instanceId }));
      return result.reached === true ? { value: result } : { value: result, error: walkError(result) };
    }
    case 'run':
      return runCode(tools.forkHost, { ...probe, code: step.arg as string }, instanceId);
    case 'expect': {
      const allowanceS = seconds(options.timeout_s, EXPECT_YIELD_S, 0, 120);
      const result = await poll(tools.forkHost, userFunction('expect', step.arg as string), { ...probe, timeout_s: 0 }, instanceId, allowanceS);
      if (result.met === true) return { value: result.value };
      if (typeof result.last_error === 'string') return { error: `errored: ${result.last_error}` };
      return { value: result.value, error: `expected a truthy value, got ${JSON.stringify(result.value ?? null)}` };
    }
    case 'screenshot':
      return screenshot(scenario, step.arg as string, index, client, nonEmpty(options.client));
    case 'watch':
      return { value: await watchValues(tools.forkHost, { ...probe, expressions: step.arg, duration_ms: options.duration_ms }, instanceId) };
    case 'record':
      return recordStep(scenario, step, index);
  }
}

type LogGroup = { message: string; count: number; peers: string[] };

/** Groups identical lines so a message spammed every frame reads as one row with a count. */
function digest(lines: LogLine[], level: string): { rows: LogGroup[]; omitted: number } {
  const groups = new Map<string, LogGroup>();
  for (const line of lines) {
    if (line.level !== level) continue;
    const group = groups.get(line.message) ?? { message: line.message, count: 0, peers: [] };
    group.count += 1;
    if (!group.peers.includes(line.role)) group.peers.push(line.role);
    groups.set(line.message, group);
  }
  const rows = [...groups.values()];
  return {
    rows: rows.slice(0, MAX_LOG_GROUPS).map((row) => ({ ...row, message: sourcemaps.annotateText(row.message) })),
    omitted: Math.max(0, rows.length - MAX_LOG_GROUPS),
  };
}

const CHARACTER_READY = userFunction('ready', [
  'local player = game:GetService("Players").LocalPlayer',
  'local character = player and player.Character',
  'return character ~= nil and character:FindFirstChildOfClass("Humanoid") ~= nil',
].join('\n'), 'body');

/** Stops a playtest this call started, and returns why that failed when it did. */
async function stopPlaytest(host: ForkHost, instanceId: string | undefined): Promise<string | undefined> {
  try {
    const reply = parseResult(await host.soloPlaytest('stop', undefined, 15, instanceId));
    return reply.success === true ? undefined : String(reply.message ?? reply.error ?? 'stop failed');
  } catch (error) {
    return errorText(error);
  }
}

async function startPlaytest(host: ForkHost, mode: 'play' | 'run', instanceId: string | undefined): Promise<void> {
  const reply = parseResult(await host.soloPlaytest('start', mode, 60, instanceId));
  if (reply.success === true) return;
  const failure = `could not start the playtest: ${String(reply.message ?? reply.error ?? 'unknown error')}`;
  // runtimeReady false means Studio accepted the start but its roles never became ready, which still leaves a playtest up.
  const launched = reply.runtimeReady === false
    || (reply.runtimeReady !== true && await playtestRunning(host, instanceId).catch(() => false));
  if (!launched) throw new Error(failure);
  const stopError = await stopPlaytest(host, instanceId);
  throw new Error(stopError === undefined
    ? `${failure} The partly started playtest was stopped.`
    : `${failure} Stopping the partly started playtest failed too: ${stopError}`);
}

export async function playtestScenario(
  tools: RobloxStudioTools,
  body: Record<string, unknown>,
  instanceId: string | undefined,
  signal?: AbortSignal,
): Promise<ForkToolResult> {
  const steps = parseSteps(body.steps);
  const start = body.start === 'run' || body.start === 'none' ? body.start : 'play';
  const host = tools.forkHost;
  const scenario: Scenario = {
    tools,
    instanceId,
    client: nonEmpty(body.client) ? body.client : 'client-1',
    quality: clamp(body.quality, 80, 1, 100),
    maxWidth: clamp(body.max_width, DEFAULT_MAX_WIDTH, 64, 8192),
    images: [],
    imageBytes: 0,
    screenshots: [],
  };
  const began = Date.now();
  const logs = new LogWatch(host, instanceId);
  await logs.begin();

  let started = false;
  if (start !== 'none' && !(await playtestRunning(host, instanceId))) {
    await startPlaytest(host, start, instanceId);
    started = true;
  }

  const lines: LogLine[] = [];
  let logError: string | undefined;
  const drain = async () => {
    try {
      lines.push(...await logs.read());
    } catch (error) {
      // A routing change mid-run (another Studio connecting) must not cost the whole report.
      logError ??= errorText(error);
    }
  };
  const results: Array<Record<string, unknown>> = [];
  let characterReady: boolean | undefined;
  let aborted = false;
  let stopped = false;
  let stopError: string | undefined;
  try {
    if (started && start === 'play') {
      // Input sent before the character spawns is silently lost.
      characterReady = await poll(host, CHARACTER_READY, { peer: scenario.client, timeout_s: 15 }, instanceId)
        .then((result) => result.met === true, () => false);
    }
    let drained = Date.now();
    for (const [offset, step] of steps.entries()) {
      if (signal?.aborted) {
        aborted = true;
        break;
      }
      const index = offset + 1;
      const stepStart = Date.now();
      let outcome: StepOutcome;
      try {
        outcome = await runStep(scenario, step, index);
      } catch (error) {
        outcome = { error: errorText(error) };
      }
      results.push({
        index,
        kind: step.kind,
        ...(nonEmpty(step.options.label) ? { label: step.options.label } : {}),
        ok: outcome.error === undefined,
        ms_offset: stepStart - began,
        duration_ms: Date.now() - stepStart,
        ...(outcome.value !== undefined ? { value: outcome.value } : {}),
        ...(outcome.error !== undefined ? { error: sourcemaps.annotateText(outcome.error) } : {}),
      });
      if (Date.now() - drained >= LOG_DRAIN_MS) {
        await drain();
        drained = Date.now();
      }
      if (outcome.error !== undefined && body.stop_on_failure !== false) break;
    }
    await wait(LOG_SETTLE_MS);
    await drain();
  } finally {
    if (started && body.keep_running !== true) {
      stopError = await stopPlaytest(host, instanceId);
      stopped = stopError === undefined;
    }
  }

  const expectations = results.filter((result) => result.kind === 'expect');
  const errors = digest(lines, 'ERR');
  const warnings = digest(lines, 'WARN');
  const report = {
    ok: results.length === steps.length && results.every((result) => result.ok === true),
    steps: results,
    assertions: {
      passed: expectations.filter((result) => result.ok === true).length,
      failed: expectations.filter((result) => result.ok !== true).length,
    },
    ...(results.length < steps.length ? { not_run: steps.length - results.length } : {}),
    ...(aborted ? { aborted: true } : {}),
    logs: {
      errors: errors.rows,
      warnings: warnings.rows,
      ...(errors.omitted + warnings.omitted > 0 ? { omitted_groups: errors.omitted + warnings.omitted } : {}),
      ...(logError !== undefined ? { read_error: logError } : {}),
    },
    ...(scenario.screenshots.length > 0 ? { screenshots: scenario.screenshots } : {}),
    duration_ms: Date.now() - began,
    playtest: {
      started,
      stopped,
      ...(characterReady !== undefined ? { character_ready: characterReady } : {}),
      ...(stopError !== undefined ? { stop_error: stopError } : {}),
    },
  };
  return { content: [{ type: 'text', text: JSON.stringify(report) }, ...scenario.images] };
}

// They run generated Luau, so they stay out of the read-only inspector edition (category write).
const READ_ONLY_PROBE = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const instanceIdArg = { type: 'string', description: 'Studio process ID when ambiguous.' } as const;
const peerArg = { type: 'string', description: 'Luau peer, defaults to server in a playtest, else edit.' } as const;
const vmArg = { type: 'string', enum: ['plugin', 'game'], description: 'plugin (default), or game to share the game require cache.' } as const;
const axis = (name: string, space: string) => ({ type: 'number', description: `${space} ${name}.` });
const xyz = (space: string) => ({ x: axis('X', space), y: axis('Y', space), z: axis('Z', space) });

const definitions: ToolDefinition[] = [
  {
    name: 'playtest_scenario',
    category: 'write',
    description: 'Use to run a scripted playtest of inputs, waits, checks, screenshots and recordings in one call with one report.',
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: 'Steps in order, each with exactly one kind key.',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', description: 'Enum.KeyCode name to tap on the client.' },
              text: { type: 'string', description: 'Text typed into the focused TextBox.' },
              click: {
                anyOf: [
                  { type: 'string' },
                  { type: 'object', properties: { x: axis('X', 'Viewport pixel'), y: axis('Y', 'Viewport pixel') }, required: ['x', 'y'] },
                ],
                description: 'GuiObject path, or {x, y} viewport pixels, to click.',
              },
              wait: { type: 'number', minimum: 0, description: 'Seconds to pause.' },
              wait_for: { type: 'string', description: 'Luau condition polled until truthy.' },
              walk_to: {
                anyOf: [
                  { type: 'string' },
                  {
                    type: 'object',
                    properties: {
                      path: { type: 'string', description: 'Instance path to walk to.' },
                      position: { type: 'object', properties: xyz('World'), required: ['x', 'y', 'z'], description: 'World point to walk to.' },
                      ...xyz('World'),
                    },
                  },
                ],
                description: 'Instance path, {path}, {position: {x, y, z}} or {x, y, z}.',
              },
              run: { type: 'string', description: 'Luau statements run once, the returned value is kept.' },
              expect: { type: 'string', description: 'Luau condition that must be truthy, counted as an assertion.' },
              screenshot: { type: 'string', description: 'Label of a viewport capture added to the result.' },
              watch: { type: 'object', additionalProperties: { type: 'string' }, description: 'Name to Luau expression map, sampled over duration_ms.' },
              record: { type: 'number', minimum: 0.5, maximum: MAX_RECORD_S, description: 'Seconds of viewport to record into a timed grid.' },
              stamp: { type: 'string', description: 'Luau value drawn on each recorded frame.' },
              fps: { type: 'integer', minimum: 1, maximum: 30, description: 'Frames a second a record step grabs, defaults to 15.' },
              frame_width: { type: 'integer', minimum: 64, maximum: 1280, description: 'Width of each recorded frame, defaults to 480.' },
              sheet_frames: { type: 'integer', minimum: 1, maximum: 48, description: 'Frames shown in a record grid, defaults to 24.' },
              label: { type: 'string', description: 'Name for this step in the report.' },
              client: { type: 'string', description: 'client-N that this input step drives.' },
              peer: peerArg,
              vm: vmArg,
              hold_s: { type: 'number', minimum: 0, maximum: 10, description: 'Seconds a key is held, defaults to 0.1.' },
              timeout_s: { type: 'number', minimum: 0, maximum: 300, description: 'Limit in seconds for waits, walks, runs and yielding expects.' },
              duration_ms: { type: 'number', minimum: 100, maximum: 30000, description: 'Sampling window in ms.' },
              interval_ms: { type: 'number', minimum: 16, maximum: 10000, description: 'Poll or sample interval in ms.' },
            },
          },
        },
        client: { type: 'string', description: 'Client driven by input steps, defaults to client-1.' },
        start: { type: 'string', enum: ['play', 'run', 'none'], description: 'Playtest started when none runs, defaults to play.' },
        keep_running: { type: 'boolean', description: 'Leave a playtest this call started running.' },
        stop_on_failure: { type: 'boolean', description: 'End at the first failed step, defaults to true.' },
        quality: { type: 'number', minimum: 1, maximum: 100, default: 80, description: 'JPEG quality of screenshots.' },
        max_width: { type: 'integer', minimum: 64, default: DEFAULT_MAX_WIDTH, description: 'Screenshots wider than this are shrunk, defaults to 1280.' },
        instance_id: instanceIdArg,
      },
      required: ['steps'],
    },
  },
  {
    name: 'wait_for',
    category: 'write',
    annotations: READ_ONLY_PROBE,
    description: 'Use to wait until a condition holds in Studio, such as a loading screen gone, instead of a polling loop.',
    inputSchema: {
      type: 'object',
      properties: {
        condition: { type: 'string', description: 'Luau expression, or body with return, polled until truthy.' },
        log: { type: 'string', description: 'Substring or /regex/ awaited in runtime logs instead.' },
        peer: { type: 'string', description: 'Peer to poll: server in a playtest, else edit. Log: every peer.' },
        vm: vmArg,
        timeout_s: { type: 'number', minimum: 0, maximum: 120, default: 10, description: 'Give up after this many seconds.' },
        interval_ms: { type: 'number', minimum: 16, maximum: 10000, default: 100, description: 'Delay between polls in ms.' },
        instance_id: instanceIdArg,
      },
    },
  },
  {
    name: 'watch',
    category: 'write',
    description: 'Use to sample values over a window, such as which lights or effects are on during a cutscene, in one call.',
    inputSchema: {
      type: 'object',
      properties: {
        expressions: { type: 'object', additionalProperties: { type: 'string' }, description: 'Name to Luau expression map, at most 10.' },
        action: { type: 'string', description: 'Luau spawned in the same VM when sampling starts.' },
        peer: peerArg,
        vm: vmArg,
        duration_ms: { type: 'number', minimum: 100, maximum: 30000, default: 3000, description: 'Sampling window in ms.' },
        interval_ms: { type: 'number', minimum: 16, maximum: 5000, default: 100, description: 'Delay between samples in ms.' },
        instance_id: instanceIdArg,
      },
      required: ['expressions'],
    },
  },
];

const guide = `
## Playtest scenarios

- playtest_scenario is the preferred way to test gameplay.
  One call starts a solo playtest when none runs, runs every step, collects errors and warnings from every peer, and stops the playtest it started.
- Each step object has exactly one kind key (key, text, click, wait, wait_for, walk_to, run, expect, screenshot, watch or record).
  Optional label, client, peer, vm, hold_s, timeout_s, duration_ms and interval_ms tune that step.
- record takes seconds of viewport to record, like record_viewport, with optional fps, frame_width, sheet_frames and stamp.
  Its timed grid joins the screenshots as an image, its summary is the step value, and a scenario takes at most 4 record steps.
- A cutscene check fits one call: wait_for the game to load, run what triggers it, wait_for the moment (a peer=client-1 condition on the cutscene's own clock), then record with stamp set to that clock.
  The scenario starts a fresh playtest, so code changed on disk is loaded too.
- Input steps (key, text, click, walk_to) and screenshots use client, which defaults to client-1.
  Pass client on a step to drive another client of a running multiplayer_playtest, since the scenario itself only starts solo playtests.
- After it starts play mode it waits up to 15 seconds for the local character, because input sent before the spawn is lost.
  playtest.character_ready reports the outcome.
- click takes a GuiObject path (PlayerGui.Main.Play works) or {x, y} in viewport pixels.
  Coordinates read off a screenshot must be multiplied by that screenshot's scale when the report lists one.
- walk_to takes an instance path, {path}, {position: {x, y, z}} or {x, y, z}.
- Prefer wait_for steps over fixed waits, so the scenario moves on as soon as the game is ready.
- expect steps are the assertions, and a falsy value or an error fails them.
  An expect checks once, but a check that yields (InvokeServer) may take up to its timeout_s, 5 seconds by default.
- With stop_on_failure (the default) the first failed step ends the run, and not_run counts the skipped steps.
- A playtest this call started is stopped even after a failure, and so is one whose start timed out before every role was ready.
  keep_running=true leaves a started playtest up for follow-up calls.
- Screenshots show the step's client while a playtest client runs, and the edit viewport otherwise.
  They are shrunk to max_width (1280 by default) and appended as images in step order.
- report.screenshots gives each image's number, width, height and, when shrunk, scale.
- All screenshots of one call share an 8 MB budget, and a shot that would pass it fails its step, so keep them few or lower quality.
- logs groups identical errors and warnings with a count and the peers that logged them, so an error spammed every frame is one row.
- The MCP client waits for the whole scenario, so keep one call under a couple of minutes and split longer flows with keep_running=true.
- wait_for runs its polling loop inside Studio, so a long wait is one round trip.
  A condition that errors counts as not yet true, and the last error is reported when it times out.
- A check that yields (WaitForChild, InvokeServer) runs in its own thread and counts as not met if it still yields at timeout_s.
  Use FindFirstChild in conditions rather than WaitForChild.
- wait_for with log waits for a runtime log line (a substring, or /regex/flags) logged after the call started.
  It reads every peer unless peer names one, and the MCP server polls the log buffers about every 250 ms.
  A peer that is not connected fails the call at once.
- watch samples up to 10 expressions on one peer.
  Vector3, Vector2 and CFrame values become rounded arrays plus a name.magnitude series.
  Runs over 600 samples are thinned evenly, while summary still uses every sample.
- A watch expression must not yield, and one that does is recorded as an error sample.
- watch action is spawned in the same VM right after the first sample, so t=0 shows the state before it.
- Conditions and expressions are Luau expressions, or bodies containing return.
  They run with the same trust as execute_luau, and compile and runtime errors name the caller's own line (condition:2).
- A run step that returns nothing has no value in the report.
- Long strings in values are cut to 300 characters (120 in watch samples).
- The default peer is the server while a playtest runs, else edit.
  LocalPlayer, PlayerGui and the camera need peer=client-N.
- vm=plugin (the default) runs in the plugin VM, which sees the DataModel but gets fresh copies of ModuleScripts.
  vm=game runs in the game VM and shares the game's require cache, so module state is visible, but it needs a running playtest.
`;

export const playtestFeature: ForkFeature = {
  name: 'playtest',
  definitions,
  handlers: {
    playtest_scenario: (tools, body, context) => playtestScenario(tools, body, body.instance_id as string | undefined, context?.signal),
    wait_for: async (tools, body, context) => {
      const log = body.log;
      if (nonEmpty(log) && body.condition !== undefined) throw new Error('pass condition or log, not both');
      return toolText(nonEmpty(log)
        ? await waitForLog(tools.forkHost, { ...body, log }, body.instance_id as string | undefined, context?.signal)
        : await waitForCondition(tools.forkHost, body, body.instance_id as string | undefined));
    },
    watch: async (tools, body) => toolText(await watchValues(tools.forkHost, body, body.instance_id as string | undefined)),
  },
  instructions: [
    {
      tools: ['playtest_scenario'],
      text: 'Test gameplay with playtest_scenario, which starts and stops the playtest and runs inputs, waits, assertions and screenshots in one call.',
    },
    {
      tools: ['wait_for', 'watch'],
      text: 'Instead of loops with task.wait in execute_luau or eval, use wait_for to wait for a state and watch to sample values over time.',
    },
  ],
  guide,
};
