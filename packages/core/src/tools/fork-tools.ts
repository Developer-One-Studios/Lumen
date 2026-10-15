import { SourcemapResolver, parseInstancePath, formatInstancePath } from '../sourcemap.js';
import {
  cameraRestoreLuau,
  cameraSetLuau,
  clientCameraRestoreLuau,
  clientCameraSetLuau,
  fuzzRemoteLuau,
  guiCenterLuau,
  inspectGuiLuau,
  lagAuditLuau,
  leakSnapshotLuau,
  listRemotesLuau,
  multiEditLuau,
  navigateLuau,
  perfStatsLuau,
  profileToggleLuau,
  replicationProbeLuau,
  withArgs,
  type CameraSave,
} from './fork-luau.js';

export interface PeerTarget {
  role: string;
  peerId: string;
}

/** A tool's default target, and the roles an instance_id naming one Peer may select instead. */
export interface TargetDefault {
  fallback: string;
  accepts: (role: string) => boolean;
}

const anyRole = (): boolean => true;
const isClientRole = (role: string): boolean => /^client-\d+$/.test(role);
const isRuntimeRole = (role: string): boolean => role === 'server' || isClientRole(role);

// The slice of RobloxStudioTools the composite tools are built on.
export interface ForkHost {
  /** With a default, an instance_id naming one accepted Peer picks it when target is omitted. */
  peerTargets(target: string | undefined, instanceId: string | undefined, defaults?: TargetDefault): Promise<PeerTarget[]>;
  requestPeer(endpoint: string, data: unknown, peerId: string, timeoutMs?: number): Promise<unknown>;
  soloPlaytest(action: string, mode?: string, timeout?: number, instanceId?: string): Promise<ToolResult>;
  getRuntimeLogs(instanceId?: string, cursor?: string): Promise<ToolResult>;
}

type ToolResult = { content: Array<{ type: string; text?: string }> };

const EXECUTE = '/api/execute-luau';
const EVAL = '/api/eval-runtime';
const RUNTIME_LOGS = '/api/get-runtime-logs';

export const sourcemaps = new SourcemapResolver();

function text(body: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(body) }] };
}

function parseResult(result: ToolResult): Record<string, unknown> {
  const raw = result.content.find((item) => item.type === 'text')?.text;
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** execute-luau signals failure with success=false, eval-runtime with ok=false or a missing bridge; both carry error. */
export function assertRan(response: unknown, context?: string): Record<string, unknown> {
  const fail = (message: string) => new Error(context ? `${context}: ${message}` : message);
  if (!response || typeof response !== 'object') throw fail('Studio returned no response');
  const reply = response as Record<string, unknown>;
  if (reply.success === false || reply.ok === false || typeof reply.error === 'string') {
    throw fail(String(reply.error ?? reply.message ?? 'Luau execution failed'));
  }
  return reply;
}

/** Unwraps execute-luau (returnValue) and eval-runtime (result) replies into the table the snippet returned. */
export function luauValue(response: unknown): Record<string, unknown> {
  const reply = assertRan(response);
  const raw = reply.returnValue ?? reply.result;
  if (typeof raw !== 'string') throw new Error('Luau returned no value');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`Luau returned a non-JSON value: ${raw.slice(0, 200)}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { value };
  const record = value as Record<string, unknown>;
  if (typeof record.error === 'string') throw new Error(record.error);
  return record;
}

/** Refuses Studio-side edits to scripts Rojo syncs from disk, which the next sync would silently overwrite. */
export async function assertNotSynced(studioPath: string | undefined, resolver: SourcemapResolver = sourcemaps): Promise<void> {
  if (process.env.ROBLOX_ALLOW_SYNCED_EDITS === '1' || studioPath === undefined) return;
  // Before the first rojo build finishes a lookup finds nothing, which would let a synced edit through.
  if (!resolver.current()) await resolver.refresh();
  const file = resolver.fileForPath(studioPath, false);
  if (file) {
    throw new Error(
      `${studioPath} is synced by Rojo from ${resolver.displayFile(file)}; edit that file instead, the next sync would overwrite a Studio edit.`,
    );
  }
}

export async function assertSubtreeNotSynced(studioPath: string | undefined, dryRun: boolean, resolver: SourcemapResolver = sourcemaps): Promise<void> {
  if (dryRun || process.env.ROBLOX_ALLOW_SYNCED_EDITS === '1') return;
  if (!resolver.current()) await resolver.refresh();
  const synced = resolver.syncedUnder(studioPath);
  if (synced.length > 0) {
    throw new Error(
      `${synced.length} script(s) under ${studioPath ?? 'game'} are synced by Rojo (for example ${synced[0]}); `
      + 'edit the files on disk, or pass a path outside the synced tree.',
    );
  }
}

type Series = { label: string; values: number[] };

function trend(series: Series[], minGrowth: (label: string) => number) {
  return series
    .map(({ label, values }) => {
      const growth = values[values.length - 1] - values[0];
      // Allow one dip so a single GC between rounds does not hide a leak.
      let dips = 0;
      for (let i = 1; i < values.length; i++) if (values[i] < values[i - 1]) dips++;
      return { label, values, growth: Math.round(growth * 1000) / 1000, steady: dips <= 1 };
    })
    .filter((row) => row.growth >= minGrowth(row.label) && row.steady)
    .sort((a, b) => b.growth / Math.max(Math.abs(b.values[0]), 1) - a.growth / Math.max(Math.abs(a.values[0]), 1));
}

const DEFAULT_REPLICATED_PROPERTIES = [
  'Parent', 'Position', 'Orientation', 'Size', 'Anchored', 'CanCollide', 'Transparency', 'Color', 'Material',
  'Value', 'Text', 'Visible', 'Enabled', 'Health', 'MaxHealth', 'WalkSpeed', 'Archivable',
];

export type CameraView = { position: number[]; look_at?: number[]; label?: string };

const MAX_CAMERA_VIEWS = 8;

function cameraPoint(value: unknown, name: string): number[] {
  if (!Array.isArray(value) || value.length !== 3 || !value.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    throw new Error(`${name} must be [x, y, z]`);
  }
  return value as number[];
}

/** Validates the camera placements of one capture_views call. */
export function cameraViews(views: unknown): CameraView[] {
  if (!Array.isArray(views) || views.length === 0 || views.length > MAX_CAMERA_VIEWS) {
    throw new Error(`views must be an array of 1 to ${MAX_CAMERA_VIEWS} camera placements`);
  }
  return views.map((view, index) => {
    if (!view || typeof view !== 'object' || Array.isArray(view)) throw new Error(`views[${index}] must be an object`);
    const entry = view as Record<string, unknown>;
    const placement: CameraView = { position: cameraPoint(entry.camera_position, `views[${index}].camera_position`) };
    if (entry.look_at !== undefined) {
      const target = cameraPoint(entry.look_at, `views[${index}].look_at`);
      if (target.every((n, axis) => n === placement.position[axis])) throw new Error(`views[${index}].look_at must differ from camera_position`);
      placement.look_at = target;
    }
    if (entry.label !== undefined) {
      if (typeof entry.label !== 'string') throw new Error(`views[${index}].label must be a string`);
      placement.label = entry.label.slice(0, 100);
    }
    return placement;
  });
}

export class ForkTools {
  private captureChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly host: ForkHost) {}

  /** One capture at a time: overlapping calls would save each other's temporary camera as the user's view, or shoot it. */
  serializeCapture<T>(run: () => Promise<T>): Promise<T> {
    const next = this.captureChain.then(run, run);
    this.captureChain = next.catch(() => undefined);
    return next;
  }

  private async runOn(peer: PeerTarget, code: string, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    return luauValue(await this.host.requestPeer(EXECUTE, { code }, peer.peerId, timeoutMs));
  }

  private async single(target: string | undefined, instanceId: string | undefined, fallback: string, accepts?: (role: string) => boolean): Promise<PeerTarget> {
    const peers = accepts
      ? await this.host.peerTargets(target, instanceId, { fallback, accepts })
      : await this.host.peerTargets(target ?? fallback, instanceId);
    if (peers.length !== 1) throw new Error(`target must name one peer, ${peers.length} matched`);
    return peers[0];
  }

  private async runtimePeers(instanceId: string | undefined): Promise<PeerTarget[]> {
    const peers = (await this.host.peerTargets('all', instanceId)).filter((peer) => peer.role !== 'edit');
    if (peers.length === 0) throw new Error('No playtest is running; start one with solo_playtest or multiplayer_playtest.');
    return peers;
  }

  async perfStats(body: Record<string, unknown>) {
    const durationMs = clamp(body.duration_ms, 3000, 500, 15_000);
    const args = {
      duration_ms: durationMs,
      sample_ms: clamp(body.sample_ms, 250, 50, 1000),
      remotes: body.remotes === true,
      top_remotes: clamp(body.top_remotes, 10, 1, 50),
    };
    const peers = await this.host.peerTargets(body.target as string | undefined, body.instance_id as string | undefined, { fallback: 'all', accepts: anyRole });
    const code = perfStatsLuau(args);
    const settled = await Promise.allSettled(peers.map((peer) => this.runOn(peer, code, durationMs + 20_000)));
    const result: Record<string, unknown> = {};
    settled.forEach((outcome, index) => {
      result[peers[index].role] = outcome.status === 'fulfilled' ? outcome.value : { error: String(outcome.reason?.message ?? outcome.reason) };
    });
    return text(result);
  }

  async lagAudit(body: Record<string, unknown>) {
    const peer = await this.single(body.target as string | undefined, body.instance_id as string | undefined, 'edit', anyRole);
    const root = typeof body.root === 'string' && body.root !== '' ? body.root : 'game.Workspace';
    return text(await this.runOn(peer, lagAuditLuau({ root, top: clamp(body.top, 10, 1, 50) }), 60_000));
  }

  async profileToggle(body: Record<string, unknown>) {
    const category = body.category;
    if (typeof category !== 'string') throw new Error('category is required');
    if (category === 'instance' && typeof body.path !== 'string') throw new Error('category="instance" needs path');
    const durationMs = clamp(body.duration_ms, 2000, 500, 10_000);
    const peer = await this.single(body.target as string | undefined, body.instance_id as string | undefined, 'client-1', isRuntimeRole);
    if (peer.role === 'edit') throw new Error('profile_toggle runs on a playtest server or client, never edit');
    const code = profileToggleLuau({ category, path: body.path as string | undefined, duration_ms: durationMs });
    return text({ peer: peer.role, ...(await this.runOn(peer, code, durationMs * 2 + 30_000)) });
  }

  async leakCheck(body: Record<string, unknown>) {
    const action = body.action;
    if (typeof action !== 'string' || action.trim() === '') throw new Error('action is required: Luau run in the game VM once per iteration');
    const iterations = clamp(body.iterations, 5, 2, 50);
    const settleMs = clamp(body.settle_ms, 1500, 0, 30_000);
    const watch = Array.isArray(body.watch) ? body.watch.filter((item): item is string => typeof item === 'string').slice(0, 10) : [];
    const peer = await this.single(body.target as string | undefined, body.instance_id as string | undefined, 'server', isRuntimeRole);
    if (peer.role === 'edit') throw new Error('leak_check needs a running playtest peer');

    // Compiled into the chunk itself, game code has no loadstring unless the place enables it.
    const watchCode = watch.length === 0 ? undefined : [
      'local values = {}',
      ...watch.map((expression, index) =>
        `do local ok, value = pcall(function() return (${expression}) end) values["${index + 1}"] = if ok and type(value) == "number" and value == value and math.abs(value) ~= math.huge then value else nil end`),
      'return values',
    ].join('\n');
    // Watch expressions read module state, so they run in the game VM where require shares the game's cache.
    const snapshot = async () => {
      const snap = await this.runOn(peer, leakSnapshotLuau(), 60_000);
      if (watchCode) {
        const values = luauValue(await this.host.requestPeer(EVAL, { code: watchCode }, peer.peerId, 30_000));
        snap.watch = Object.fromEntries(watch.map((expression, index) => [expression, values[String(index + 1)]]));
      }
      return snap;
    };

    const snapshots: Record<string, unknown>[] = [await snapshot()];
    for (let i = 0; i < iterations; i++) {
      assertRan(await this.host.requestPeer(EVAL, { code: action }, peer.peerId, 60_000), `action failed on iteration ${i + 1}`);
      if (settleMs > 0) await wait(settleMs);
      snapshots.push(await snapshot());
    }

    // The first iteration warms caches and pools, so growth is measured from after it.
    const measured = snapshots.slice(1);
    const series: Series[] = [];
    const add = (label: string, pick: (snap: Record<string, unknown>) => unknown) => {
      const values = measured.map((snap) => pick(snap));
      if (values.every((value) => typeof value === 'number')) series.push({ label, values: values as number[] });
    };
    add('totalMb', (snap) => snap.totalMb);
    add('instanceCount', (snap) => snap.instanceCount);
    add('unparentedInstances', (snap) => snap.unparentedInstances);
    const first = measured[0];
    for (const tag of Object.keys((first.tags as Record<string, number>) ?? {})) add(`tag:${tag}`, (snap) => (snap.tags as Record<string, number>)[tag]);
    // A class that first appears mid-run is as telling as one that grows.
    const classes = new Set(measured.flatMap((snap) => Object.keys((snap.classes as Record<string, number>) ?? {})));
    for (const cls of classes) add(`class:${cls}`, (snap) => (snap.classes as Record<string, number>)[cls] ?? 0);
    const sources = new Set(measured.flatMap((snap) => Object.keys((snap.unparentedBy as Record<string, number>) ?? {})));
    for (const source of sources) add(`unparented:${source}`, (snap) => (snap.unparentedBy as Record<string, number> | undefined)?.[source] ?? 0);
    for (const expression of watch) add(`watch:${expression}`, (snap) => (snap.watch as Record<string, unknown>)?.[expression]);

    const rounds = measured.length - 1;
    const growing = trend(series, (label) =>
      label.startsWith('tag:') || label === 'totalMb' ? 0.5 : label.startsWith('watch:') ? 1 : Math.max(2, rounds));
    return text({
      peer: peer.role,
      iterations,
      measuredRounds: rounds,
      growing: growing.slice(0, 25).map((row) => ({ metric: row.label, growth: row.growth, perIteration: Math.round((row.growth / Math.max(rounds, 1)) * 1000) / 1000, values: row.values })),
      final: { totalMb: measured[measured.length - 1].totalMb, instanceCount: measured[measured.length - 1].instanceCount },
      note: growing.length === 0 ? 'Nothing grew steadily across the measured rounds.' : undefined,
    });
  }

  async replicationDiff(body: Record<string, unknown>) {
    if (typeof body.path !== 'string') throw new Error('path is required');
    const properties = Array.isArray(body.properties) && body.properties.length > 0
      ? body.properties.filter((item): item is string => typeof item === 'string')
      : DEFAULT_REPLICATED_PROPERTIES;
    const tolerance = typeof body.tolerance === 'number' ? Math.max(0, body.tolerance) : 0.05;
    const peers = await this.runtimePeers(body.instance_id as string | undefined);
    const code = replicationProbeLuau({ path: body.path, properties, children: body.children === true });
    const probes = await Promise.all(peers.map(async (peer) => {
      try {
        return { role: peer.role, probe: await this.runOn(peer, code) };
      } catch (error) {
        return { role: peer.role, probe: { error: error instanceof Error ? error.message : String(error) } };
      }
    }));

    const server = probes.find((entry) => entry.role === 'server');
    const flatten = (probe: Record<string, unknown>) => ({
      ...((probe.properties as Record<string, unknown>) ?? {}),
      ...Object.fromEntries(Object.entries((probe.attributes as Record<string, unknown>) ?? {}).map(([k, v]) => [`@${k}`, v])),
      ...(probe.children ? { children: probe.children } : {}),
    });
    const same = (a: unknown, b: unknown): boolean => {
      if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= tolerance;
      if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => same(value, b[index]));
      return JSON.stringify(a) === JSON.stringify(b);
    };

    const views = probes.map((entry) => ({ role: entry.role, exists: entry.probe.exists === true, values: entry.probe.exists ? flatten(entry.probe) : {} }));
    const reference = views.find((view) => view.role === 'server') ?? views[0];
    const keys = new Set(views.flatMap((view) => Object.keys(view.values)));
    const differences: Record<string, Record<string, unknown>> = {};
    for (const key of keys) {
      const base = (reference.values as Record<string, unknown>)[key];
      if (views.some((view) => !same((view.values as Record<string, unknown>)[key], base))) {
        differences[key] = Object.fromEntries(views.map((view) => [view.role, (view.values as Record<string, unknown>)[key] ?? null]));
      }
    }
    return text({
      path: body.path,
      exists: Object.fromEntries(views.map((view) => [view.role, view.exists])),
      networkOwner: server?.probe.networkOwner,
      differences,
      inSync: Object.keys(differences).length === 0 && views.every((view) => view.exists === reference.exists),
      errors: probes.filter((entry) => typeof entry.probe.error === 'string').map((entry) => ({ role: entry.role, error: entry.probe.error })),
    });
  }

  async fuzzRemotes(body: Record<string, unknown>) {
    const instanceId = body.instance_id as string | undefined;
    const client = await this.single(body.target as string | undefined, instanceId, 'client-1', isClientRole);
    if (!/^client-\d+$/.test(client.role)) throw new Error('fuzz_remotes fires from a client peer (target=client-N)');
    const server = (await this.runtimePeers(instanceId)).find((peer) => peer.role === 'server');
    const includeFunctions = body.include_functions === true;
    const spam = clamp(body.spam, 50, 0, 1000);
    const settleMs = clamp(body.settle_ms, 750, 100, 10_000);

    let remotes: string[];
    if (Array.isArray(body.remotes) && body.remotes.length > 0) {
      remotes = body.remotes.filter((item): item is string => typeof item === 'string');
    } else {
      const root = typeof body.root === 'string' ? body.root : 'game.ReplicatedStorage';
      const listed = await this.runOn(client, listRemotesLuau({ root, include_functions: includeFunctions }));
      remotes = (listed.remotes as string[]) ?? [];
    }
    const limit = clamp(body.max_remotes, 20, 1, 100);
    const skipped = remotes.length - limit;
    remotes = remotes.slice(0, limit);

    const readServer = async (since?: number) => {
      if (!server) return { entries: [] as Array<Record<string, unknown>>, nextSince: since };
      const reply = await this.host.requestPeer(RUNTIME_LOGS, since === undefined ? { tail: 0 } : { since }, server.peerId, 15_000) as Record<string, unknown>;
      return { entries: (reply.entries as Array<Record<string, unknown>>) ?? [], nextSince: reply.nextSince as number | undefined };
    };

    let cursor = (await readServer()).nextSince;
    const results: Array<Record<string, unknown>> = [];
    for (const path of remotes) {
      let fired: Record<string, unknown>;
      try {
        fired = await this.runOn(client, fuzzRemoteLuau({ path, spam, include_functions: includeFunctions }), 60_000);
      } catch (error) {
        results.push({ remote: path, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      await wait(settleMs);
      const logs = await readServer(cursor);
      cursor = logs.nextSince ?? cursor;
      const serverErrors = logs.entries
        .filter((entry) => entry.level === 'ERR' || entry.level === 'WARN')
        .map((entry) => sourcemaps.annotateText(String(entry.message)))
        .filter((message, index, all) => all.indexOf(message) === index)
        .slice(0, 8);
      results.push({ ...fired, serverErrors });
      if (fired.kicked === true) break;
    }
    const flagged = (entry: Record<string, unknown>) => Boolean((entry.serverErrors as unknown[] | undefined)?.length || entry.kicked || entry.error);
    const passed = results.filter((entry) => !entry.skipped);
    return text({
      client: client.role,
      fuzzed: passed.length,
      ...(skipped > 0 ? { notFuzzed: skipped } : {}),
      findings: passed.filter(flagged),
      clean: passed.filter((entry) => !flagged(entry)).map((entry) => entry.remote),
      ...(passed.length < results.length ? { skippedFunctions: results.filter((entry) => entry.skipped).map((entry) => entry.remote) } : {}),
      ...(server ? {} : { note: 'No server peer was found, server errors were not collected.' }),
    });
  }

  async inspectGui(body: Record<string, unknown>) {
    const peer = await this.single(body.target as string | undefined, body.instance_id as string | undefined, 'client-1', isClientRole);
    const at = body.at as { x?: unknown; y?: unknown } | undefined;
    const args = {
      root: typeof body.root === 'string' ? body.root : undefined,
      at: at && typeof at.x === 'number' && typeof at.y === 'number' ? { x: at.x, y: at.y } : undefined,
      max_nodes: clamp(body.max_nodes, 150, 1, 1000),
      visible_only: body.visible_only !== false,
      text: typeof body.text === 'string' ? body.text : undefined,
    };
    return text(await this.runOn(peer, inspectGuiLuau(args)));
  }

  /** Viewport pixel centre of a GuiObject on a client, for simulate_mouse_input instance_path. */
  async guiCenter(path: string, target: string | undefined, instanceId: string | undefined): Promise<{ x: number; y: number; path: string }> {
    const peer = await this.single(target, instanceId, 'client-1', isClientRole);
    const center = await this.runOn(peer, guiCenterLuau({ path }));
    return center as { x: number; y: number; path: string };
  }

  /**
   * Shoots every view in order from the camera of the peer that renders the capture, then restores that camera once.
   * Callers serialize: a concurrent capture would shoot or save this temporary camera.
   * capture learns whether the camera still showed the requested view after it settled.
   */
  async withCameraViews<T>(
    peer: PeerTarget,
    views: CameraView[],
    capture: (index: number, held: boolean) => Promise<T>,
  ): Promise<{ results: T[]; restoreError?: string }> {
    const client = /^client-\d+$/.test(peer.role);
    let attempted = false;
    let saved: CameraSave | undefined;
    const restore = async (): Promise<string | undefined> => {
      if (!attempted) return undefined;
      // Without a saved camera, for example when the first move timed out after it ran, the snippet uses its _G stash.
      const code = client ? clientCameraRestoreLuau({ saved }) : cameraRestoreLuau({ saved });
      try {
        await this.runOn(peer, code);
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };
    const results: T[] = [];
    try {
      for (const [index, view] of views.entries()) {
        const placement = { position: view.position, look_at: view.look_at };
        attempted = true;
        const placed = await this.runOn(peer, client ? clientCameraSetLuau(placement) : cameraSetLuau(placement));
        saved ??= placed.saved as CameraSave | undefined;
        results.push(await capture(index, placed.held !== false));
      }
    } catch (error) {
      const restoreError = await restore();
      if (restoreError === undefined) throw error;
      throw new Error(`${error instanceof Error ? error.message : String(error)} (restoring the camera also failed: ${restoreError})`);
    }
    return { results, restoreError: await restore() };
  }

  async navigateCharacter(body: Record<string, unknown>) {
    const position = body.position as { x?: unknown; y?: unknown; z?: unknown } | undefined;
    const hasPosition = position && [position.x, position.y, position.z].every((value) => typeof value === 'number');
    if (!hasPosition && typeof body.path !== 'string') throw new Error('navigate_character needs position {x,y,z} or path');
    const timeoutS = clamp(body.timeout_s, 20, 1, 120);
    const peer = await this.single(body.target as string | undefined, body.instance_id as string | undefined, 'client-1', isClientRole);
    const code = navigateLuau({
      position: hasPosition ? position as { x: number; y: number; z: number } : undefined,
      path: hasPosition ? undefined : body.path as string,
      speed_multiplier: typeof body.speed_multiplier === 'number' ? Math.min(10, Math.max(0.1, body.speed_multiplier)) : 1,
      timeout_s: timeoutS,
    });
    return text(await this.runOn(peer, code, timeoutS * 1000 + 20_000));
  }

  async multiEdit(body: Record<string, unknown>) {
    const path = body.path;
    if (typeof path !== 'string' || path === '') throw new Error('path is required');
    const edits = body.edits;
    if (!Array.isArray(edits) || edits.length === 0) throw new Error('edits must be a non-empty array');
    for (const [index, edit] of edits.entries()) {
      if (!edit || typeof edit.old_string !== 'string' || typeof edit.new_string !== 'string') {
        throw new Error(`edit ${index + 1} needs old_string and new_string strings`);
      }
    }
    await assertNotSynced(path);
    const parts = parseInstancePath(path);
    if (!parts || parts.length === 0) throw new Error(`invalid path ${path}`);
    const peer = await this.single('edit', body.instance_id as string | undefined, 'edit');
    const code = multiEditLuau({
      path,
      parent_path: formatInstancePath(parts.slice(0, -1)),
      name: parts[parts.length - 1],
      class_name: typeof body.class_name === 'string' && body.class_name !== '' ? body.class_name : undefined,
      edits: edits as Array<{ old_string: string; new_string: string; replace_all?: boolean }>,
    });
    return text(await this.runOn(peer, code, 60_000));
  }

  async resolveSource(body: Record<string, unknown>) {
    if (typeof body.project_root === 'string' && body.project_root !== '') sourcemaps.setProjectRoot(body.project_root);
    const map = await sourcemaps.refresh();
    const index = map.index;
    if (!index) {
      return text({
        sourcemap: null,
        note: `No Rojo sourcemap (${map.error ?? 'nothing found'}). Pass project_root, the folder holding default.project.json. The map is built in memory with rojo sourcemap.`,
      });
    }
    const studio = Array.isArray(body.paths) ? body.paths.filter((item): item is string => typeof item === 'string') : [];
    const files = Array.isArray(body.files) ? body.files.filter((item): item is string => typeof item === 'string') : [];
    const ageSeconds = Math.round((Date.now() - index.mtimeMs) / 1000);
    return text({
      sourcemap: index.generatedFrom ?? index.sourcemapPath,
      ageSeconds,
      ...(map.error ? { rojo_error: map.error, stale_because: map.stale } : {}),
      scripts: index.byPath.size,
      paths: Object.fromEntries(studio.map((path) => {
        const file = sourcemaps.fileForPath(path);
        return [path, file ? sourcemaps.displayFile(file) : null];
      })),
      files: Object.fromEntries(files.map((file) => [file, sourcemaps.pathForFile(file) ?? null])),
      ...(ageSeconds > 600 ? { warning: 'The map is over 10 minutes old. Pass regenerate=true to verify_sync after moving files.' } : {}),
    });
  }

  async runTests(body: Record<string, unknown>) {
    const instanceId = body.instance_id as string | undefined;
    const timeoutS = clamp(body.timeout_s, 60, 5, 600);
    const expected = clamp(body.expected_summaries, 1, 1, 20);
    const summary = new RegExp(typeof body.summary_pattern === 'string' ? body.summary_pattern : '(\\d+) passed, (\\d+) failed');
    const failLine = new RegExp(typeof body.fail_pattern === 'string' ? body.fail_pattern : '\\bFAIL\\b\\s*(.*)');
    const mode = body.mode === 'run' ? 'run' : 'play';

    const startedAt = Date.now() / 1000;
    const start = parseResult(await this.host.soloPlaytest('start', mode, 60, instanceId));
    if (typeof start.error === 'string') throw new Error(`could not start the playtest: ${start.error}`);

    // Each peer keeps a small ring buffer, so read incrementally or a long suite's early failures are gone by the summary.
    const entries: Array<Record<string, unknown>> = [];
    let cursor: string | undefined;
    let summaries: RegExpExecArray[] = [];
    const deadline = Date.now() + timeoutS * 1000;
    while (Date.now() < deadline) {
      const logs = parseResult(await this.host.getRuntimeLogs(instanceId, cursor));
      if (typeof logs.nextCursor === 'string') cursor = logs.nextCursor;
      // Merged logs include the edit peer's history, so only lines logged after the start count.
      for (const entry of (logs.entries as Array<Record<string, unknown>>) ?? []) {
        if (typeof entry.ts === 'number' && entry.ts >= startedAt - 1) entries.push(entry);
      }
      summaries = entries.map((entry) => summary.exec(String(entry.message))).filter((match): match is RegExpExecArray => match !== null);
      if (summaries.length >= expected) break;
      await wait(1000);
    }

    if (body.keep_running !== true) await this.host.soloPlaytest('stop', undefined, 15, instanceId);
    const failures = entries
      .map((entry) => failLine.exec(String(entry.message)))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => sourcemaps.annotateText(match[1] ?? match[0]));
    const errors = entries
      .filter((entry) => entry.level === 'ERR' && !failLine.test(String(entry.message)))
      .map((entry) => sourcemaps.annotateText(String(entry.message)))
      .slice(0, 20);
    const passed = summaries.reduce((total, match) => total + Number(match[1] ?? 0), 0);
    const failed = summaries.reduce((total, match) => total + Number(match[2] ?? 0), 0);
    return text({
      completed: summaries.length >= expected,
      summaries: summaries.map((match) => match[0]),
      passed,
      failed,
      failures,
      errors,
      ...(summaries.length < expected ? { note: `Saw ${summaries.length} of ${expected} summary line(s) before the ${timeoutS}s timeout.` } : {}),
      stopped: body.keep_running !== true,
    });
  }

  async auditAssets(body: Record<string, unknown>) {
    const peer = await this.single('edit', body.instance_id as string | undefined, 'edit');
    const root = typeof body.root === 'string' && body.root !== '' ? body.root : 'game';
    const scan = await this.runOn(peer, withArgs(ASSET_SCAN_LUAU, { root }), 60_000);
    const assets = (scan.assets as Array<{ id: number; kind: string; uses: number; example: string }>) ?? [];
    const creatorId = scan.creatorId as number;
    const creatorType = scan.creatorType as string;
    const limit = clamp(body.max_assets, 150, 1, 1000);
    const checked = assets
      .sort((a, b) => Number(b.kind === 'Animation') - Number(a.kind === 'Animation') || Number(b.kind === 'Sound') - Number(a.kind === 'Sound'))
      .slice(0, limit);

    const lookups = new Map<number, AssetLookup>();
    const queue = [...new Set(checked.map((asset) => asset.id))];
    await Promise.all(Array.from({ length: 4 }, async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) lookups.set(id, await fetchAssetDetails(id));
    }));

    const owned = (details: Record<string, unknown>) => {
      const creator = details.Creator as { Id?: number; CreatorType?: string; CreatorTargetId?: number } | undefined;
      const id = creator?.CreatorTargetId ?? creator?.Id;
      return id === creatorId && String(creator?.CreatorType).toLowerCase() === creatorType.toLowerCase();
    };
    const findings: Array<Record<string, unknown>> = [];
    const unchecked: Array<Record<string, unknown>> = [];
    for (const asset of checked) {
      const lookup = lookups.get(asset.id);
      if (!lookup || 'error' in lookup) {
        // Only a definite not-found is a finding; rate limits and outages say nothing about the asset.
        if (lookup?.notFound) findings.push({ ...asset, problem: 'asset not found; it was deleted, moderated or made private' });
        else unchecked.push({ id: asset.id, error: lookup?.error ?? 'not looked up' });
        continue;
      }
      const details = lookup.details;
      const robloxOwned = (details.Creator as { Id?: number } | undefined)?.Id === 1;
      if (creatorId > 0 && !robloxOwned && !owned(details)) {
        if (asset.kind === 'Animation') {
          findings.push({ ...asset, owner: (details.Creator as { Name?: string })?.Name, problem: 'animation not owned by the experience owner; it will not play in live servers' });
        } else if (asset.kind === 'Sound') {
          findings.push({ ...asset, owner: (details.Creator as { Name?: string })?.Name, problem: 'audio not owned by the experience owner; it only plays if it is public or shared with this experience' });
        }
      }
    }
    return text({
      creator: creatorId > 0 ? { id: creatorId, type: creatorType } : null,
      ...(creatorId > 0 ? {} : { note: 'The place is unpublished, so ownership could not be compared; only availability was checked.' }),
      scanned: assets.length,
      checked: checked.length,
      byKind: assets.reduce<Record<string, number>>((counts, asset) => ({ ...counts, [asset.kind]: (counts[asset.kind] ?? 0) + 1 }), {}),
      findings,
      ...(unchecked.length > 0 ? { unchecked: unchecked.slice(0, 20), uncheckedCount: unchecked.length } : {}),
    });
  }

  async datastoreRead(body: Record<string, unknown>) {
    const key = process.env.ROBLOX_OPEN_CLOUD_API_KEY;
    if (!key) throw new Error('datastore_read needs ROBLOX_OPEN_CLOUD_API_KEY with DataStore read permissions for the universe.');
    let universeId = typeof body.universe_id === 'number' ? body.universe_id : undefined;
    if (universeId === undefined) {
      const peer = await this.single('edit', body.instance_id as string | undefined, 'edit');
      const place = await this.runOn(peer, 'return { gameId = game.GameId }');
      universeId = Number(place.gameId);
      if (!universeId) throw new Error('The place is unpublished; pass universe_id.');
    }
    const base = `https://apis.roblox.com/datastores/v1/universes/${universeId}/standard-datastores`;
    const scope = typeof body.scope === 'string' ? body.scope : 'global';
    const limit = String(clamp(body.limit, 20, 1, 100));
    let url: URL;
    if (typeof body.datastore !== 'string') {
      url = new URL(base);
      url.searchParams.set('limit', limit);
      if (typeof body.prefix === 'string') url.searchParams.set('prefix', body.prefix);
    } else if (typeof body.key !== 'string') {
      url = new URL(`${base}/datastore/entries`);
      url.searchParams.set('datastoreName', body.datastore);
      url.searchParams.set('scope', scope);
      url.searchParams.set('limit', limit);
      if (typeof body.prefix === 'string') url.searchParams.set('prefix', body.prefix);
    } else {
      url = new URL(`${base}/datastore/entries/entry`);
      url.searchParams.set('datastoreName', body.datastore);
      url.searchParams.set('entryKey', body.key);
      url.searchParams.set('scope', scope);
    }
    if (typeof body.cursor === 'string') url.searchParams.set('cursor', body.cursor);
    const response = await fetch(url, { headers: { 'x-api-key': key }, signal: AbortSignal.timeout(20_000) });
    const raw = await response.text();
    if (!response.ok) throw new Error(`Open Cloud returned HTTP ${response.status}: ${raw.slice(0, 300)}`);
    let value: unknown = raw;
    try {
      value = JSON.parse(raw);
    } catch {
      // Entries may legitimately hold a plain string.
    }
    const serialized = JSON.stringify(value);
    return text({
      universeId,
      ...(typeof body.datastore === 'string' ? { datastore: body.datastore, scope } : {}),
      ...(typeof body.key === 'string' ? { key: body.key, version: response.headers.get('roblox-entry-version') } : {}),
      value: serialized.length > 60_000 ? `${serialized.slice(0, 60_000)}…` : value,
      ...(serialized.length > 60_000 ? { truncated: true } : {}),
    });
  }
}

type AssetLookup = { details: Record<string, unknown> } | { error: string; notFound: boolean };

export async function fetchAssetDetails(id: number, attempts = 3, backoffMs = 1500): Promise<AssetLookup> {
  let last = 'no attempt';
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await wait(backoffMs * attempt);
    try {
      const response = await fetch(`https://economy.roblox.com/v2/assets/${id}/details`, { signal: AbortSignal.timeout(15_000) });
      if (response.ok) return { details: await response.json() as Record<string, unknown> };
      await response.body?.cancel();
      if (response.status === 400 || response.status === 404) return { error: `HTTP ${response.status}`, notFound: true };
      last = `HTTP ${response.status}`;
      if (response.status !== 429 && response.status < 500) break;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
  }
  return { error: last, notFound: false };
}

const ASSET_SCAN_LUAU = String.raw`
local root = resolve(ARGS.root)
if root == nil then return { error = "root not found: " .. ARGS.root } end
local FIELDS = {
	Animation = { "AnimationId" }, Sound = { "SoundId" }, MeshPart = { "MeshId", "TextureID" },
	SpecialMesh = { "MeshId", "TextureId" }, Decal = { "Texture" }, Texture = { "Texture" },
	ImageLabel = { "Image" }, ImageButton = { "Image" }, ParticleEmitter = { "Texture" }, Beam = { "Texture" },
	Trail = { "Texture" }, Shirt = { "ShirtTemplate" }, Pants = { "PantsTemplate" }, Sky = { "SkyboxBk", "SkyboxDn", "SkyboxFt", "SkyboxLf", "SkyboxRt", "SkyboxUp" },
}
local KIND = { AnimationId = "Animation", SoundId = "Sound", MeshId = "Mesh" }
local found = {}
local scanned = 0
local function consider(instance)
	local fields = FIELDS[instance.ClassName]
	if fields == nil then return end
	for _, field in fields do
		local ok, value = pcall(function() return (instance :: any)[field] end)
		if ok and type(value) == "string" then
			local id = tonumber(string.match(value, "^rbxassetid://(%d+)") or string.match(value, "[?&]id=(%d+)"))
			if id then
				local entry = found[id]
				if entry == nil then
					entry = { id = id, kind = KIND[field] or "Image", uses = 0, example = pathOf(instance) }
					found[id] = entry
				end
				entry.uses += 1
			end
		end
	end
end
consider(root)
for _, instance in root:GetDescendants() do
	scanned += 1
	if scanned % 5000 == 0 then task.wait() end
	consider(instance)
end
local assets = {}
for _, entry in found do table.insert(assets, entry) end
return { creatorId = game.CreatorId, creatorType = game.CreatorType.Name, assets = assets }
`;

export { clamp, parseResult, text as toolText, wait };
