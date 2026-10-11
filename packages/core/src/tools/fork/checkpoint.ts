import { canonicalPath, parseInstancePath, type SourcemapResolver } from '../../sourcemap.js';
import type { ToolDefinition } from '../definitions.js';
import { clamp, luauValue, sourcemaps, toolText, type ForkHost } from '../fork-tools.js';
import {
  checkpointChangesLuau,
  checkpointCreateLuau,
  checkpointDropLuau,
  checkpointListLuau,
  checkpointRevertLuau,
} from './checkpoint-luau.js';
import type { ForkFeature, ForkToolResult } from './feature.js';

const EXECUTE = '/api/execute-luau';
const ACTIONS = ['create', 'changes', 'revert', 'list', 'drop'];
// Snapshotting, diffing and replacing walk every instance under the roots, yielding as they go.
const WALK_TIMEOUT_MS = 300_000;

export const DEFAULT_CHECKPOINT_ROOTS = [
  'game.Workspace',
  'game.ReplicatedStorage',
  'game.ReplicatedFirst',
  'game.ServerScriptService',
  'game.ServerStorage',
  'game.StarterGui',
  'game.StarterPack',
  'game.StarterPlayer.StarterPlayerScripts',
  'game.StarterPlayer.StarterCharacterScripts',
  'game.Lighting',
  'game.SoundService',
  'game.Teams',
];

export interface CheckpointRecord {
  id: string;
  instance_id?: string;
  created_at: string;
  roots: string[];
  instances: number;
  subtrees: number;
  terrain: boolean;
}

export interface CheckpointOptions {
  known?: Map<string, CheckpointRecord>;
  resolver?: SourcemapResolver;
}

// Snapshots live in the plugin VM. This only remembers what this server created, so a
// snapshot lost to a plugin reload can be told apart from an id that never existed.
const KNOWN = new Map<string, CheckpointRecord>();

function checkpointId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '' || value.length > 64) {
    throw new Error('id must be a non-empty string of at most 64 characters');
  }
  return value;
}

function pathList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((item): item is string => typeof item === 'string' && item !== '')) {
    throw new Error(`${name} must be a non-empty array of instance paths`);
  }
  return value;
}

// The snippet matches paths as text, so every accepted spelling is turned into the canonical game.X.Y form.
function revertPaths(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  return pathList(value, 'paths').map((path) => {
    const canonical = canonicalPath(path);
    if (canonical === undefined) throw new Error(`paths: cannot parse ${path}, pass a path such as game.Workspace.Map`);
    return canonical;
  });
}

function syncedParts(resolver: SourcemapResolver): string[][] {
  if (process.env.ROBLOX_ALLOW_SYNCED_EDITS === '1') return [];
  return resolver.syncedUnder(undefined)
    .map((path) => parseInstancePath(path))
    .filter((parts): parts is string[] => parts !== undefined && parts.length > 0);
}

export async function runCheckpoint(
  host: ForkHost,
  body: Record<string, unknown>,
  instanceId: string | undefined,
  options: CheckpointOptions = {},
): Promise<ForkToolResult> {
  const known = options.known ?? KNOWN;
  const resolver = options.resolver ?? sourcemaps;
  const action = body.action;
  if (typeof action !== 'string' || !ACTIONS.includes(action)) throw new Error(`action must be one of ${ACTIONS.join(', ')}`);
  const id = checkpointId(body.id);
  if (action === 'drop' && id === undefined) throw new Error('drop needs id');

  const peers = await host.peerTargets('edit', instanceId);
  if (peers.length !== 1) throw new Error(`checkpoint needs exactly one edit peer, ${peers.length} matched`);
  const peer = peers[0];
  if (peer.role !== 'edit') throw new Error(`checkpoint only works on the edit DataModel, not ${peer.role}`);
  const run = async (code: string, timeoutMs = 30_000) => luauValue(await host.requestPeer(EXECUTE, { code }, peer.peerId, timeoutMs));
  const keyOf = (checkpoint: string) => JSON.stringify([instanceId ?? null, checkpoint]);
  const mine = () => [...known.values()].filter((record) => record.instance_id === instanceId);

  const lost = (reply: Record<string, unknown>): Error => {
    const forgotten = id !== undefined
      ? [known.get(keyOf(id))].filter((record): record is CheckpointRecord => record !== undefined)
      : mine();
    for (const record of forgotten) known.delete(keyOf(record.id));
    if (forgotten.length > 0) {
      const names = forgotten.map((record) => `${record.id} (created ${record.created_at})`).join(', ');
      return new Error(
        `Checkpoint ${names} is gone from Studio. Snapshots live only in the edit plugin's memory, `
        + 'so the plugin reloaded or Studio restarted since. Create a new checkpoint.',
      );
    }
    if (id === undefined) return new Error('No checkpoint exists in this Studio yet, create one first.');
    const existing = Array.isArray(reply.existing) ? reply.existing.map(String) : [];
    return new Error(`No checkpoint ${id} in this Studio, existing: ${existing.length > 0 ? existing.join(', ') : 'none'}.`);
  };

  if (action === 'create') {
    const roots = body.roots === undefined ? DEFAULT_CHECKPOINT_ROOTS : pathList(body.roots, 'roots');
    const report = await run(checkpointCreateLuau({
      id,
      roots,
      explicit_roots: body.roots !== undefined,
      include_terrain: body.include_terrain === true,
      max_instances: clamp(body.max_instances, 200_000, 1, 1_000_000),
    }), WALK_TIMEOUT_MS);
    const created = String(report.id);
    known.set(keyOf(created), {
      id: created,
      instance_id: instanceId,
      created_at: new Date().toISOString(),
      roots: Array.isArray(report.roots) ? report.roots.map(String) : roots,
      instances: Number(report.instances),
      subtrees: Number(report.subtrees),
      terrain: report.terrain === 'captured',
    });
    return toolText(report);
  }

  if (action === 'changes') {
    const reply = await run(checkpointChangesLuau({
      id,
      synced: syncedParts(resolver),
      max_items: clamp(body.max_items, 50, 1, 500),
    }), WALK_TIMEOUT_MS);
    if (reply.missing === true) throw lost(reply);
    return toolText(reply);
  }

  if (action === 'revert') {
    const reply = await run(checkpointRevertLuau({ id, paths: revertPaths(body.paths), synced: syncedParts(resolver) }), WALK_TIMEOUT_MS);
    if (reply.missing === true) throw lost(reply);
    return toolText(reply);
  }

  if (action === 'drop') {
    const dropId = id as string;
    const reply = await run(checkpointDropLuau({ id: dropId }));
    const remembered = known.delete(keyOf(dropId));
    if (reply.missing === true) {
      if (remembered) return toolText({ id: dropId, dropped: false, note: 'It was already gone from Studio after a plugin reload or Studio restart.' });
      throw lost(reply);
    }
    return toolText(reply);
  }

  const reply = await run(checkpointListLuau());
  const checkpoints = Array.isArray(reply.checkpoints) ? reply.checkpoints as Array<{ id?: unknown }> : [];
  const present = new Set(checkpoints.map((checkpoint) => String(checkpoint.id)));
  const gone = mine().filter((record) => !present.has(record.id));
  for (const record of gone) known.delete(keyOf(record.id));
  return toolText({
    checkpoints,
    ...(gone.length > 0
      ? {
        lost: gone.map((record) => ({ id: record.id, created_at: record.created_at })),
        note: 'Lost checkpoints vanished with a plugin reload or Studio restart.',
      }
      : {}),
  });
}

const CHECKPOINT_DEFINITION: ToolDefinition = {
  name: 'checkpoint',
  category: 'write',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  description: 'Use before experimenting in edit mode to snapshot the place, list what changed since, or undo it all in one step.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ACTIONS, description: 'create, changes, revert, list or drop.' },
      id: { type: 'string', description: 'Checkpoint name, create picks cpN when omitted.' },
      roots: { type: 'array', items: { type: 'string' }, description: 'create: subtrees to snapshot, defaults to the main services.' },
      include_terrain: { type: 'boolean', description: 'create: also copy Terrain voxels, slow and memory heavy.' },
      max_instances: { type: 'number', minimum: 1, maximum: 1_000_000, default: 200_000, description: 'create: refuse above this many instances.' },
      paths: { type: 'array', items: { type: 'string' }, description: 'revert: only these subtrees, as listed by changes.' },
      max_items: { type: 'number', minimum: 1, maximum: 500, default: 50, description: 'changes: rows per list.' },
      instance_id: { type: 'string', description: 'Studio process ID when ambiguous.' },
    },
    required: ['action'],
  },
};

const GUIDE = `
## Checkpoints

- checkpoint action=create snapshots the edit DataModel before an experiment, and action=revert later restores every changed subtree as one Ctrl+Z step named "MCP: revert checkpoint <id>".
- The default roots are Workspace (without Terrain and the viewer's CurrentCamera), ReplicatedStorage, ReplicatedFirst, ServerScriptService, ServerStorage, StarterGui, StarterPack, StarterPlayerScripts, StarterCharacterScripts, Lighting, SoundService and Teams, plus the main Lighting, Workspace and SoundService settings.
- A root below a service, such as game.Workspace.Map, is snapshotted as one subtree, so deleting, renaming or moving it is caught and reverted too.
- action=changes compares names, parents, script sources, attributes, tags and a fixed list of common properties (parts, GUI, lights, sounds, particles, constraints, Lighting effects, Atmosphere and Sky), not every property.
- An edit confined to a property outside that list is not detected, so changes reports clean and revert leaves it in place.
- Its subtrees list names each changed child of a root (or the root itself when it sits below a service), which is the unit a revert replaces with a fresh copy of the snapshot, untracked properties included.
- Everything in a replaced subtree becomes a new object, and revert repoints welds, constraints, ObjectValues, Adornee, PrimaryPart and similar references between snapshotted instances at the new copies.
- References it could not repoint, because their target is gone from the place, come back under danglingReferences.
- References held outside the roots, the Studio selection and open script tabs still point at the old objects after a revert.
- Pass paths, as listed under subtrees or in any form other tools accept, to revert only some of them, and the stored copy stays untouched so a checkpoint can be reverted again.
- Subtrees holding scripts synced by Rojo are never replaced and come back as skipped, so change those files on disk instead.
- Children that were not Archivable at create time have no copy and cannot be restored, and deeper instances with Archivable off are lost when their subtree is replaced.
- Revert refuses to start while another edit by the plugin is still recording its undo step, and when it fails part way its error says whether Studio cancelled the partial changes.
- Later calls understand a Ctrl+Z of a revert, but undoing two reverts of the same subtree makes changes report it as removed and added.
- Terrain is only captured with include_terrain, it is copied whole, pasted back by every revert that covers it, and never compared by action=changes.
- Snapshots live in the edit plugin's memory, never in the saved place, and cost memory roughly the size of the copied content, plus the subtrees each revert replaced.
- They vanish when the plugin reloads or Studio restarts, so free them with action=drop once an experiment is settled.
`;

export const checkpointFeature: ForkFeature = {
  name: 'checkpoint',
  definitions: [CHECKPOINT_DEFINITION],
  handlers: {
    checkpoint: (tools, body) => runCheckpoint(tools.forkHost, body, body.instance_id as string | undefined),
  },
  instructions: [{
    tools: ['checkpoint'],
    text: 'Before experimental edits in edit mode, run checkpoint action=create, then checkpoint action=revert undoes them in one step.',
  }],
  guide: GUIDE,
};
