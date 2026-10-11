import type { ToolDefinition } from '../definitions.js';
import { clamp, luauValue, toolText, type ForkHost, type PeerTarget } from '../fork-tools.js';
import type { ForkFeature } from './feature.js';
import { spatialAuditLuau, spatialBoundsLuau, spatialReachLuau, type Spot } from './spatial-luau.js';

const EXECUTE = '/api/execute-luau';
const MAX_PARTS = 20_000;
const AUDIT_BUDGET_S = 60;
const DEFAULT_GRAVITY = 196.2;

const READ_ONLY_PROBE = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const MAX_PATHS = 200;
const spot = (description: string) => ({ anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'number' } }], description });

const SPATIAL_CHECK: ToolDefinition = {
  name: 'spatial_check',
  category: 'write',
  annotations: READ_ONLY_PROBE,
  description: 'Use to check 3D layout numerically: floating, overlaps, jump gaps, reach, distances.',
  inputSchema: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['audit', 'gaps', 'reach', 'measure'], description: 'Check to run.' },
      root: { type: 'string', description: 'audit: subtree, default Workspace.' },
      paths: { type: 'array', items: { type: 'string' }, description: 'audit: only these objects.' },
      limit: { type: 'number', description: 'audit: rows per list.' },
      tolerance: { type: 'number', description: 'Touch slack, studs.' },
      platforms: { type: 'array', items: { type: 'string' }, description: 'gaps: parts in jump order.' },
      character: {
        type: 'object',
        properties: {
          walk_speed: { type: 'number', description: 'Studs/s.' },
          jump_height: { type: 'number', description: 'Studs.' },
        },
        description: 'Overrides Studio stats.',
      },
      from: spot('Path or [x, y, z].'),
      to: spot('Path or [x, y, z].'),
      target: { type: 'string', description: 'edit (default), server or client-N.' },
      instance_id: { type: 'string', description: 'Studio process ID when ambiguous.' },
    },
    required: ['mode'],
  },
};

type Vec = [number, number, number];
export interface Box { path?: string; min: Vec; max: Vec; extents: Vec; clearance?: number; below?: string }
export interface RawCharacter {
  gravity?: number;
  walkSpeed?: number;
  useJumpPower?: boolean;
  jumpPower?: number;
  jumpHeight?: number;
  source?: string;
}
export interface CharacterOverrides { walk_speed?: number; jump_height?: number }
export interface JumpStats { walkSpeed: number; jumpHeight: number; gravity: number; jumpVelocity: number; source: string }

const round = (value: number, places = 2) => Math.round(value * 10 ** places) / 10 ** places;
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

function spotArg(value: unknown, name: string): Spot {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === 'number' && Number.isFinite(n))) return value as number[];
  throw new Error(`${name} must be an instance path or [x, y, z]`);
}

function pathsArg(value: unknown): string[] | undefined {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) return undefined;
  if (!Array.isArray(value) || value.length > MAX_PATHS || !value.every((item) => typeof item === 'string' && item !== '')) {
    throw new Error(`paths must be 1 to ${MAX_PATHS} instance paths, so split a longer list over several audits`);
  }
  return value as string[];
}

function overridesArg(value: unknown): CharacterOverrides {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('character must be an object');
  const raw = value as Record<string, unknown>;
  const out: CharacterOverrides = {};
  for (const key of ['walk_speed', 'jump_height'] as const) {
    if (raw[key] === undefined) continue;
    const n = num(raw[key]);
    if (n === undefined || n < 0) throw new Error(`character.${key} must be a non-negative number`);
    out[key] = n;
  }
  return out;
}

/** JumpPower is the launch speed, so it converts to a height through h = v^2 / 2g. */
export function jumpStats(raw: RawCharacter, overrides: CharacterOverrides = {}): JumpStats {
  const gravity = num(raw.gravity) ?? DEFAULT_GRAVITY;
  if (gravity <= 0) throw new Error(`Workspace.Gravity is ${gravity}, so a jump never comes back down`);
  const walkSpeed = overrides.walk_speed ?? num(raw.walkSpeed) ?? 16;
  const jumpHeight = Math.max(0, overrides.jump_height
    ?? (raw.useJumpPower ? (num(raw.jumpPower) ?? 50) ** 2 / (2 * gravity) : num(raw.jumpHeight) ?? 7.2));
  return {
    walkSpeed,
    jumpHeight,
    gravity,
    jumpVelocity: Math.sqrt(2 * gravity * jumpHeight),
    source: `${raw.source ?? 'defaults'}${Object.keys(overrides).length > 0 ? ' with overrides' : ''}`,
  };
}

/** Airtime back down to a surface `rise` studs higher is (v0 + sqrt(v0^2 - 2 g rise)) / g, and WalkSpeed times that is the widest gap a running jump clears. */
export function jumpReach(stats: JumpStats, rise: number): { airtime: number; reach: number } | undefined {
  const v0 = stats.jumpVelocity;
  const discriminant = v0 * v0 - 2 * stats.gravity * rise;
  if (discriminant < 0) return undefined;
  const airtime = (v0 + Math.sqrt(discriminant)) / stats.gravity;
  return { airtime, reach: stats.walkSpeed * airtime };
}

function axisGap(a: Box, b: Box, axis: number): number {
  return Math.max(0, b.min[axis] - a.max[axis], a.min[axis] - b.max[axis]);
}

export function analyzeJumps(boxes: Box[], stats: JumpStats) {
  const jumps = [];
  for (let i = 1; i < boxes.length; i++) {
    const from = boxes[i - 1];
    const to = boxes[i];
    const gap = Math.hypot(axisGap(from, to, 0), axisGap(from, to, 2));
    const rise = to.max[1] - from.max[1];
    const reach = jumpReach(stats, rise);
    const margin = reach === undefined ? stats.jumpHeight - rise : reach.reach - gap;
    jumps.push({
      from: from.path,
      to: to.path,
      gap: round(gap),
      rise: round(rise),
      reach: reach === undefined ? 0 : round(reach.reach),
      airtime: reach === undefined ? 0 : round(reach.airtime, 3),
      jumpable: margin >= 0,
      margin: round(margin),
      limitedBy: reach === undefined ? 'height' : 'distance',
    });
  }
  return jumps;
}

export function compareBoxes(a: Box, b: Box) {
  const center = (box: Box) => box.min.map((low, axis) => (low + box.max[axis]) / 2) as Vec;
  const ca = center(a);
  const cb = center(b);
  const offset = cb.map((value, axis) => value - ca[axis]);
  const separation = [0, 1, 2].map((axis) => axisGap(a, b, axis));
  const intersection = [0, 1, 2].map((axis) => Math.min(a.max[axis], b.max[axis]) - Math.max(a.min[axis], b.min[axis]));
  const overlapping = intersection.every((extent) => extent > 0);
  const describe = (box: Box, c: Vec) => ({
    ...(box.path ? { path: box.path } : { position: box.min }),
    center: c.map((value) => round(value, 3)),
    size: box.max.map((high, axis) => round(high - box.min[axis], 3)),
    extents: box.extents,
    min: box.min,
    max: box.max,
    groundClearance: box.clearance ?? null,
    ...(box.below ? { ground: box.below } : {}),
  });
  return {
    from: describe(a, ca),
    to: describe(b, cb),
    offset: offset.map((value) => round(value, 3)),
    centerDistance: round(Math.hypot(...offset), 3),
    closestDistance: round(Math.hypot(...separation), 3),
    horizontalGap: round(Math.hypot(separation[0], separation[2]), 3),
    verticalGap: round(separation[1], 3),
    rise: round(b.max[1] - a.max[1], 3),
    overlapping,
    ...(overlapping ? { overlap: intersection.map((extent) => round(extent, 3)) } : {}),
  };
}

async function onePeer(host: ForkHost, target: unknown, instanceId: string | undefined): Promise<PeerTarget> {
  const peers = await host.peerTargets(typeof target === 'string' && target !== '' ? target : 'edit', instanceId);
  if (peers.length !== 1) throw new Error(`target must name one peer, ${peers.length} matched`);
  return peers[0];
}

async function run(host: ForkHost, peer: PeerTarget, code: string, timeoutMs: number) {
  return luauValue(await host.requestPeer(EXECUTE, { code }, peer.peerId, timeoutMs));
}

export async function spatialCheck(host: ForkHost, body: Record<string, unknown>, instanceId: string | undefined): Promise<Record<string, unknown>> {
  const mode = body.mode;
  if (mode !== 'audit' && mode !== 'gaps' && mode !== 'reach' && mode !== 'measure') {
    throw new Error('mode must be audit, gaps, reach or measure');
  }
  const tolerance = num(body.tolerance) === undefined ? 0.05 : Math.min(5, Math.max(0, body.tolerance as number));
  const overrides = overridesArg(body.character);

  if (mode === 'audit') {
    const paths = pathsArg(body.paths);
    const peer = await onePeer(host, body.target, instanceId);
    const code = spatialAuditLuau({
      root: typeof body.root === 'string' && body.root !== '' ? body.root : 'game.Workspace',
      paths,
      limit: clamp(body.limit, 20, 1, 100),
      tolerance,
      max_parts: MAX_PARTS,
      time_budget_s: AUDIT_BUDGET_S,
    });
    return { peer: peer.role, ...(await run(host, peer, code, (AUDIT_BUDGET_S + 90) * 1000)) };
  }

  if (mode === 'gaps') {
    const platforms = Array.isArray(body.platforms) ? body.platforms : [];
    if (platforms.length < 2 || platforms.length > 50 || !platforms.every((item) => typeof item === 'string' && item !== '')) {
      throw new Error('gaps needs 2 to 50 platform paths in jump order');
    }
    const peer = await onePeer(host, body.target, instanceId);
    const raw = await run(host, peer, spatialBoundsLuau({ targets: platforms as string[], ground: false, character: true, tolerance }), 60_000);
    const stats = jumpStats((raw.character ?? {}) as RawCharacter, overrides);
    const jumps = analyzeJumps(raw.boxes as Box[], stats);
    const flat = jumpReach(stats, 0);
    return {
      peer: peer.role,
      character: {
        walkSpeed: round(stats.walkSpeed),
        jumpHeight: round(stats.jumpHeight),
        gravity: round(stats.gravity),
        jumpVelocity: round(stats.jumpVelocity),
        flatReach: flat ? round(flat.reach) : 0,
        source: stats.source,
      },
      allJumpable: jumps.every((jump) => jump.jumpable),
      jumps,
    };
  }

  // a and b are the names the original measure spec used, kept out of the catalog to save space.
  const from = spotArg(body.from ?? body.a, 'from');
  const to = spotArg(body.to ?? body.b, 'to');
  const peer = await onePeer(host, body.target, instanceId);
  if (mode === 'reach') {
    const canJump = overrides.jump_height === undefined ? undefined : overrides.jump_height > 0;
    return { peer: peer.role, ...(await run(host, peer, spatialReachLuau({ from, to, can_jump: canJump }), 60_000)) };
  }
  const raw = await run(host, peer, spatialBoundsLuau({ targets: [from, to], ground: true, character: false, tolerance }), 60_000);
  const [a, b] = raw.boxes as Box[];
  return { peer: peer.role, ...compareBoxes(a, b) };
}

export const spatialFeature: ForkFeature = {
  name: 'spatial',
  definitions: [SPATIAL_CHECK],
  handlers: {
    spatial_check: async (tools, body) => toolText(await spatialCheck(tools.forkHost, body, body.instance_id as string | undefined)),
  },
  instructions: [
    {
      tools: ['spatial_check'],
      text: 'Use spatial_check to confirm placement, overlaps, jump gaps and reachability with numbers instead of judging 3D layout from screenshots.',
    },
  ],
  guide: `
## Spatial checks

- spatial_check answers layout questions with numbers, so use it instead of judging placement, gaps or overlaps from screenshots, and capture only to confirm the look.
- It reads the edit DataModel by default.
- target=server or client-N checks a running playtest, where a client only sees what it has streamed in.
- mode=audit scans root (default game.Workspace) for floating objects, overlaps between different objects, parts buried inside block parts, unanchored assemblies with nothing to land on, near zero size parts, and objects far from the main cluster or below FallenPartsDestroyHeight.
- Spatial queries only see Workspace, so root must lie inside it, and stored levels in ServerStorage or ReplicatedStorage cannot be audited in place.
- Audit objects are the outermost Models under root plus loose BaseParts, with Folders looked through, so pass a Model as root to audit the pieces inside it.
- Pass up to 200 paths to audit only some objects, such as ones you just placed, against everything else in the world, and any outside Workspace come back under notInWorkspace.
- A static object counts as floating when no part reaches its bottom from below or the side and nothing lies within tolerance under it.
- Only parts reaching the bottom hold an object up, so props sunk into its top never do and items hanging from a ceiling are listed.
- The anchored parts of an object are judged on their own, so a floating house is listed even when its hinged door shows up under falling.
- Unanchored assemblies need something under them, so loose parts touching side by side in midair are listed under falling.
- An object with nothing at all under it that carries other things counts as ground, such as a baseplate or a sky lobby floor.
- A prop sunk into a surface also appears under overlaps, so a shallow depth there usually means deliberate placement.
- falling rows with constrained=true have a constraint attached, so a rope, hinge or spring may hold them up.
- Overlap volume and depth use each part's box in its own orientation, which is exact for blocks and an upper bound for wedges, cylinders, meshes and unions.
- Invisible parts that do not collide count as triggers and are skipped, and so are player characters.
- Every audit list is sorted worst first and cut at limit, counts holds the full totals, and scanned reports partCapHit (20000 parts) or timeCapHit (60 seconds of overlap queries) when the scan was cut short.
- mode=gaps takes platforms in jump order and reports, for each jump, the horizontal gap between box edges, the rise between tops, the farthest running jump at that rise, and the margin.
- WalkSpeed and jump come from a live Humanoid in a playtest, otherwise from StarterPlayer, gravity comes from Workspace, and character overrides walk_speed or jump_height when scripts change them at runtime.
- Pass the walkable part rather than a whole model when railings or decorations stick out above the floor.
- The margin ignores the character's width, so players clear roughly one or two studs more than reach, and a jump with a small positive margin is already tight.
- mode=reach computes a PathfindingService route from one spot to another with the agent sized from the character, and nobody moves.
- Pathfinding assumes a standard jump whatever JumpHeight says, so check custom jumps with mode=gaps.
- from and to take a path or [x, y, z].
- For reach, a part or model stands for its top centre and a character model for its root part.
- mode=measure compares from and to: both boxes, their centre distance, closest distance, per axis offset, vertical gap, overlap, and each one's clearance above whatever lies below it.
`,
};
