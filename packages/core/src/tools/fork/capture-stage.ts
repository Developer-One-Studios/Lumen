import { luauValue, type ForkHost } from '../fork-tools.js';
import type { ForkToolResult } from './feature.js';
import { stageLuau, unstageLuau, type StageArgs, type StagedCopy } from './capture-stage-luau.js';

const EXECUTE = '/api/execute-luau';
const STAGE_TIMEOUT_MS = 60_000;
export const MAX_STAGED = 8;
// High above any map, so nothing of the place stands in the shot.
export const DEFAULT_STAGE_AT = [0, 10_000, 0];
const DEFAULT_SETTLE_S = 1;
const MAX_SETTLE_S = 5;
const DEFAULT_PITCH = 15;
// A little room around the framed box, so its edges are not cut.
const FRAME_MARGIN = 1.05;

type FramedView = { frame: number; yaw?: number; pitch?: number; label?: string };
type RawView = Record<string, unknown>;

function finiteNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  return value;
}

function point(value: unknown, name: string): number[] {
  if (!Array.isArray(value) || value.length !== 3 || !value.every((item) => typeof item === 'number' && Number.isFinite(item))) {
    throw new Error(`${name} must be three finite numbers [x, y, z]`);
  }
  return value as number[];
}

export function parseStage(value: unknown): StageArgs {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('stage must be an object with paths, for example {"paths": ["ReplicatedStorage.Assets.Models.Units.Gojo"]}');
  }
  const entry = value as Record<string, unknown>;
  const paths = entry.paths;
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_STAGED
    || !paths.every((item): item is string => typeof item === 'string' && item !== '')) {
    throw new Error(`stage.paths must list 1 to ${MAX_STAGED} instance paths`);
  }
  const settle = finiteNumber(entry.settle_s, 'stage.settle_s') ?? DEFAULT_SETTLE_S;
  if (settle < 0 || settle > MAX_SETTLE_S) throw new Error(`stage.settle_s must be from 0 to ${MAX_SETTLE_S}`);
  return {
    paths,
    at: entry.at === undefined ? DEFAULT_STAGE_AT : point(entry.at, 'stage.at'),
    settle_s: settle,
  };
}

/** Views either name a staged copy to frame or carry their own camera_position, which capture validates later. */
export function stageViews(views: unknown, staged: number | undefined): Array<RawView | FramedView> {
  if (!Array.isArray(views)) throw new Error('views must be an array of camera placements');
  return views.map((view, index) => {
    if (!view || typeof view !== 'object' || Array.isArray(view)) throw new Error(`views[${index}] must be an object`);
    const entry = view as RawView;
    if (entry.frame === undefined) return entry;
    if (staged === undefined) throw new Error(`views[${index}].frame frames a staged copy, so pass stage with it`);
    const frame = entry.frame;
    if (typeof frame !== 'number' || !Number.isInteger(frame) || frame < 0 || frame > staged) {
      throw new Error(`views[${index}].frame must be 0 for every staged copy or 1 to ${staged} for one of them`);
    }
    if (entry.camera_position !== undefined || entry.look_at !== undefined) {
      throw new Error(`views[${index}] frames a staged copy, which places the camera itself, so leave camera_position and look_at out`);
    }
    if (entry.label !== undefined && typeof entry.label !== 'string') throw new Error(`views[${index}].label must be a string`);
    return {
      frame,
      yaw: finiteNumber(entry.yaw, `views[${index}].yaw`),
      pitch: finiteNumber(entry.pitch, `views[${index}].pitch`),
      label: entry.label as string | undefined,
    };
  });
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/**
 * Places the camera so the framed box fills the narrower of the two fields of view.
 * yaw turns about +Y from the copy's front: a Roblox model facing -Z has its left side toward -X, which 90 reaches.
 */
export function frameView(view: FramedView, staged: StagedCopy[], fovDegrees: number, aspect: number) {
  const chosen = view.frame === 0 ? staged : [staged[view.frame - 1]];
  const low = [0, 1, 2].map((axis) => Math.min(...chosen.map((copy) => copy.center[axis] - copy.size[axis] / 2)));
  const high = [0, 1, 2].map((axis) => Math.max(...chosen.map((copy) => copy.center[axis] + copy.size[axis] / 2)));
  const center = low.map((value, axis) => (value + high[axis]) / 2);
  const radius = Math.max(0.5, Math.hypot(...high.map((value, axis) => value - low[axis])) / 2);

  let [fx, , fz] = chosen[0].front;
  const flat = Math.hypot(fx, fz);
  if (flat < 1e-6) {
    fx = 0;
    fz = -1;
  } else {
    fx /= flat;
    fz /= flat;
  }
  const yaw = ((view.yaw ?? 0) * Math.PI) / 180;
  const dx = fx * Math.cos(yaw) + fz * Math.sin(yaw);
  const dz = -fx * Math.sin(yaw) + fz * Math.cos(yaw);
  const pitch = (Math.max(-89, Math.min(89, view.pitch ?? DEFAULT_PITCH)) * Math.PI) / 180;
  const direction = [dx * Math.cos(pitch), Math.sin(pitch), dz * Math.cos(pitch)];

  const vertical = (Math.max(1, Math.min(120, fovDegrees)) * Math.PI) / 180;
  const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * Math.max(0.1, aspect));
  const distance = (radius / Math.sin(Math.min(vertical, horizontal) / 2)) * FRAME_MARGIN;
  return {
    camera_position: center.map((value, axis) => round(value + direction[axis] * distance)),
    look_at: center.map(round),
    label: view.label ?? `${view.frame === 0 ? 'stage' : `stage-${view.frame}`}${view.yaw ? ` yaw ${view.yaw}` : ''}`,
  };
}

type Capture = (views: RawView[]) => Promise<ForkToolResult>;

// The summary is the first text block of a capture_views result.
function withStageSummary(result: ForkToolResult, summary: Record<string, unknown>): ForkToolResult {
  const index = result.content.findIndex((item) => item.type === 'text' && typeof item.text === 'string');
  if (index < 0) return { ...result, content: [{ type: 'text', text: JSON.stringify(summary) }, ...result.content] };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(result.content[index].text!) as Record<string, unknown>;
  } catch {
    return result;
  }
  const content = [...result.content];
  content[index] = { type: 'text', text: JSON.stringify({ ...parsed, ...summary }) };
  return { ...result, content };
}

/** Stages copies in the edit DataModel, shoots the views, and always takes the copies out again. */
export async function captureStaged(
  host: ForkHost,
  body: Record<string, unknown>,
  capture: Capture,
): Promise<ForkToolResult> {
  const stage = parseStage(body.stage);
  if (body.clients !== undefined) throw new Error('stage shoots the edit viewport, so leave clients out');
  const views = stageViews(body.views, stage.paths.length);
  const instanceId = body.instance_id as string | undefined;
  const peers = await host.peerTargets('all', instanceId);
  if (peers.some((peer) => peer.role !== 'edit')) {
    throw new Error('stage shoots the edit viewport, so stop the playtest first');
  }
  const edit = peers.find((peer) => peer.role === 'edit');
  if (!edit) throw new Error('stage needs an edit DataModel; pass its id from get_connected_instances');

  const placed = luauValue(await host.requestPeer(EXECUTE, { code: stageLuau(stage) }, edit.peerId, STAGE_TIMEOUT_MS));
  const staged = (Array.isArray(placed.staged) ? placed.staged : []) as StagedCopy[];
  const fov = typeof placed.fov === 'number' ? placed.fov : 70;
  const aspect = typeof placed.aspect === 'number' ? placed.aspect : 16 / 9;

  let result: ForkToolResult | undefined;
  let failure: unknown;
  try {
    result = await capture(views.map((view) => ('frame' in view && typeof view.frame === 'number'
      ? frameView(view as FramedView, staged, fov, aspect)
      : view as RawView)));
  } catch (error) {
    failure = error;
  }

  let removal: string | undefined;
  try {
    const cleared = luauValue(await host.requestPeer(EXECUTE, { code: unstageLuau() }, edit.peerId, STAGE_TIMEOUT_MS));
    if (cleared.left === true) removal = 'the staged copies are still in Workspace.__LumenStage, which is never saved, so delete it';
  } catch (error) {
    removal = `taking the staged copies out failed (${error instanceof Error ? error.message : String(error)}), so delete Workspace.__LumenStage, which is never saved`;
  }

  if (failure !== undefined) {
    const message = failure instanceof Error ? failure.message : String(failure);
    throw new Error(removal === undefined ? message : `${message} (${removal})`);
  }
  return withStageSummary(result!, {
    stage: staged.map(({ index, path, center, size }) => ({ index, path, center, size })),
    ...(placed.preloaded === false ? { stageNote: 'Some meshes or textures were still loading after 10 s, so parts may show bare.' } : {}),
    ...(removal === undefined ? {} : { stageWarning: removal }),
  });
}
