import type { ToolDefinition } from '../definitions.js';
import { luauValue, toolText, type ForkHost, type PeerTarget } from '../fork-tools.js';
import { diffDetailLuau, diffIndexLuau, type DiffArgs } from './diff-luau.js';
import type { ForkFeature, ForkToolResult } from './feature.js';

const EXECUTE = '/api/execute-luau';
// Describing a few thousand instances with every serialized property takes seconds, not milliseconds.
const DIFF_TIMEOUT_S = 120;
const MAX_INSTANCES = 50_000;
const DEFAULT_MAX_CHANGES = 50;
const MAX_CHANGES = 200;
const MAX_LISTED = 100;
// Moon Animator keeps its keyframes in AnimSaves under each rig, which differ between any two takes.
const DEFAULT_IGNORE_CLASSES = ['KeyframeSequence'];
const DEFAULT_IGNORE_NAMES = ['AnimSaves'];

type IndexEntry = { path: string; className: string; fingerprint: string };
type Side = { root: string; entries: IndexEntry[]; truncated: boolean };

function stringList(value: unknown, name: string, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) {
    throw new Error(`${name} must be an array of strings`);
  }
  return value;
}

async function editPeer(host: ForkHost, instanceId: string | undefined, side: string): Promise<PeerTarget> {
  const peers = await host.peerTargets('edit', instanceId);
  if (peers.length !== 1 || peers[0].role !== 'edit') {
    throw new Error(`side ${side} needs exactly one edit DataModel, ${peers.length} matched; pass its id from get_connected_instances`);
  }
  return peers[0];
}

function parseSide(reply: Record<string, unknown>): Side {
  const entries = Array.isArray(reply.entries) ? reply.entries : [];
  return {
    root: String(reply.root ?? ''),
    truncated: reply.truncated === true,
    entries: entries.flatMap((entry) => (Array.isArray(entry) && entry.length === 3
      ? [{ path: String(entry[0]), className: String(entry[1]), fingerprint: String(entry[2]) }]
      : [])),
  };
}

const isUnder = (path: string, ancestor: string) => ancestor !== '' && path.startsWith(`${ancestor}/`);

/** Keeps only the topmost of nested paths, each with how many listed paths it stands for. */
export function topmost(paths: string[]): Array<{ path: string; instances: number }> {
  const sorted = [...paths].sort();
  const out: Array<{ path: string; instances: number }> = [];
  for (const path of sorted) {
    const last = out[out.length - 1];
    if (last && (isUnder(path, last.path) || last.path === '')) {
      last.instances += 1;
    } else {
      out.push({ path, instances: 1 });
    }
  }
  return out;
}

export type IndexComparison = {
  same: number;
  missing: string[];
  extra: string[];
  classChanged: Array<{ path: string; a: string; b: string }>;
  changed: Array<{ path: string; className: string }>;
};

/** Matches the two trees by relative path. Instances under a class change are compared as missing and extra. */
export function compareIndexes(a: IndexEntry[], b: IndexEntry[]): IndexComparison {
  const bByPath = new Map(b.map((entry) => [entry.path, entry]));
  const aPaths = new Set(a.map((entry) => entry.path));
  const result: IndexComparison = { same: 0, missing: [], extra: [], classChanged: [], changed: [] };
  for (const entry of a) {
    const other = bByPath.get(entry.path);
    if (!other) {
      result.missing.push(entry.path);
    } else if (other.className !== entry.className) {
      result.classChanged.push({ path: entry.path, a: entry.className, b: other.className });
    } else if (other.fingerprint !== entry.fingerprint) {
      result.changed.push({ path: entry.path, className: entry.className });
    } else {
      result.same += 1;
    }
  }
  for (const entry of b) {
    if (!aPaths.has(entry.path)) result.extra.push(entry.path);
  }
  return result;
}

/** The properties and attributes whose values differ, as [a, b]. A value only one side has shows the other as null. */
export function propertyChanges(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, [unknown, unknown]> {
  const out: Record<string, [unknown, unknown]> = {};
  for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const left = a[key] ?? null;
    const right = b[key] ?? null;
    if (left !== right) out[key] = [left, right];
  }
  return out;
}

export async function diffInstances(host: ForkHost, body: Record<string, unknown>, instanceId: string | undefined): Promise<ForkToolResult> {
  const aPath = body.a_path;
  const bPath = body.b_path;
  if (typeof aPath !== 'string' || aPath === '' || typeof bPath !== 'string' || bPath === '') {
    throw new Error('a_path and b_path are required instance paths');
  }
  for (const key of ['a_instance_id', 'b_instance_id']) {
    if (body[key] !== undefined && typeof body[key] !== 'string') throw new Error(`${key} must be a string`);
  }
  const maxChanges = Math.min(MAX_CHANGES, Math.max(1, Math.round(typeof body.max_changes === 'number' ? body.max_changes : DEFAULT_MAX_CHANGES)));
  const shared = {
    ignore_classes: stringList(body.ignore_classes, 'ignore_classes', DEFAULT_IGNORE_CLASSES),
    ignore_names: stringList(body.ignore_names, 'ignore_names', DEFAULT_IGNORE_NAMES),
    ignore_properties: stringList(body.ignore_properties, 'ignore_properties', []),
  };

  // Both sides are resolved before either is read, so a wrong id fails without a slow walk.
  const aPeer = await editPeer(host, (body.a_instance_id as string | undefined) ?? instanceId, 'a');
  const bPeer = await editPeer(host, (body.b_instance_id as string | undefined) ?? instanceId, 'b');
  const run = async (peer: PeerTarget, code: string) => luauValue(await host.requestPeer(EXECUTE, { code, timeout_s: DIFF_TIMEOUT_S }, peer.peerId, (DIFF_TIMEOUT_S + 15) * 1000));
  const argsFor = (rootPath: string): DiffArgs => ({ root_path: rootPath, ...shared });

  const [aSide, bSide] = await Promise.all([
    run(aPeer, diffIndexLuau({ ...argsFor(aPath), max_instances: MAX_INSTANCES })).then(parseSide),
    run(bPeer, diffIndexLuau({ ...argsFor(bPath), max_instances: MAX_INSTANCES })).then(parseSide),
  ]);
  const comparison = compareIndexes(aSide.entries, bSide.entries);

  const detailed = comparison.changed.slice(0, maxChanges);
  const paths = detailed.map((entry) => entry.path);
  const [aDetail, bDetail] = paths.length === 0
    ? [{}, {}]
    : await Promise.all([
      run(aPeer, diffDetailLuau({ ...argsFor(aPath), paths })),
      run(bPeer, diffDetailLuau({ ...argsFor(bPath), paths })),
    ]).then((replies) => replies.map((reply) => (reply.details && typeof reply.details === 'object' ? reply.details as Record<string, Record<string, unknown>> : {})));

  const missing = topmost(comparison.missing);
  const extra = topmost(comparison.extra);
  const list = <T>(items: T[]) => ({ count: items.length, items: items.slice(0, MAX_LISTED), ...(items.length > MAX_LISTED ? { more: items.length - MAX_LISTED } : {}) });
  return toolText({
    a: { root: aSide.root, instances: aSide.entries.length, ...(aSide.truncated ? { truncated: true } : {}) },
    b: { root: bSide.root, instances: bSide.entries.length, ...(bSide.truncated ? { truncated: true } : {}) },
    identical: comparison.missing.length + comparison.extra.length + comparison.classChanged.length + comparison.changed.length === 0,
    same: comparison.same,
    only_in_a: { instances: comparison.missing.length, ...list(missing) },
    only_in_b: { instances: comparison.extra.length, ...list(extra) },
    class_changed: list(comparison.classChanged),
    changed: {
      count: comparison.changed.length,
      items: detailed.map((entry) => ({
        path: entry.path,
        class: entry.className,
        differences: propertyChanges(
          (aDetail as Record<string, Record<string, unknown>>)[entry.path] ?? {},
          (bDetail as Record<string, Record<string, unknown>>)[entry.path] ?? {},
        ),
      })),
      ...(comparison.changed.length > detailed.length ? { more: comparison.changed.length - detailed.length } : {}),
    },
    ignored: shared,
  });
}

const DIFF_DEFINITION: ToolDefinition = {
  name: 'diff_instances',
  category: 'write',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  description: 'Use to compare two instance trees, in one place or two open places, by instances, classes, properties and attributes.',
  inputSchema: {
    type: 'object',
    properties: {
      a_path: { type: 'string', description: 'Root of the first tree.' },
      b_path: { type: 'string', description: 'Root of the second tree.' },
      a_instance_id: { type: 'string', description: 'Studio process of the first tree, defaults to instance_id.' },
      b_instance_id: { type: 'string', description: 'Studio process of the second tree, defaults to instance_id.' },
      ignore_classes: { type: 'array', items: { type: 'string' }, description: 'Classes skipped with their subtrees, default KeyframeSequence.' },
      ignore_names: { type: 'array', items: { type: 'string' }, description: 'Names skipped with their subtrees, default AnimSaves.' },
      ignore_properties: { type: 'array', items: { type: 'string' }, description: 'Properties and @attributes left out of the compare.' },
      max_changes: { type: 'integer', minimum: 1, maximum: MAX_CHANGES, default: DEFAULT_MAX_CHANGES, description: 'Changed instances listed with their differences.' },
      instance_id: { type: 'string', description: 'Studio process ID when ambiguous.' },
    },
    required: ['a_path', 'b_path'],
  },
};

const GUIDE = `
## Comparing instance trees

- diff_instances compares the tree under a_path with the tree under b_path, in one place or across two open places (a_instance_id and b_instance_id, as listed by get_connected_instances).
- Instances are matched by their path below each root, so the roots may have different names and parents. Same-named siblings are matched in order and written Name#2, Name#3.
- Every serialized property ReflectionService lists for a class is compared, plus attributes (written @Name). Scripts compare Source as its line count and a fingerprint, since ReflectionService does not list it, and ScriptGuid is always left out. Numbers are rounded to 4 places and vectors and CFrames to 3, so float noise does not count as a change.
- References inside a tree are written as <relative path>, so a Beam's Attachment0 compares equal when both point at the same place in their own tree.
- only_in_a and only_in_b list the topmost missing instance of each subtree with how many instances it stands for. class_changed lists matched paths whose class differs.
- changed lists up to max_changes instances with every differing property as [a, b]; more counts the rest.
- KeyframeSequence and AnimSaves are skipped by default, since animation saves differ between any two takes. Pass empty lists to compare them too.
- It reads both places from the edit DataModel and changes nothing.
`;

export const diffFeature: ForkFeature = {
  name: 'diff',
  definitions: [DIFF_DEFINITION],
  handlers: {
    diff_instances: (tools, body) => diffInstances(tools.forkHost, body, body.instance_id as string | undefined),
  },
  instructions: [{
    tools: ['diff_instances'],
    text: 'Use diff_instances to compare two copies of content, such as an artist place and the game copy, in one call.',
  }],
  guide: GUIDE,
};
