import type { ToolDefinition } from '../definitions.js';
import { luauValue, toolText, type ForkHost, type PeerTarget } from '../fork-tools.js';
import type { ForkFeature, ForkToolResult } from './feature.js';
import { copyInstancesLuau, moveInstancesLuau } from './transfer-luau.js';

const EXECUTE = '/api/execute-luau';
const EXPORT = '/api/export-rbxm';
// Serializing and rebuilding a whole map yields as it goes, so both halves of a copy get generous deadlines.
const COPY_TIMEOUT_MS = 300_000;
const MOVE_TIMEOUT_MS = 120_000;

const point = (description: string) => ({ type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description });

function pathList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((item): item is string => typeof item === 'string' && item !== '')) {
    throw new Error('instance_paths must be a non-empty array of instance paths');
  }
  return value;
}

function vector(value: unknown, name: string): number[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== 3 || !value.every((item) => typeof item === 'number' && Number.isFinite(item))) {
    throw new Error(`${name} must be three finite numbers [x, y, z]`);
  }
  return value as number[];
}

async function editPeer(host: ForkHost, instanceId: string | undefined, role: string): Promise<PeerTarget> {
  const peers = await host.peerTargets('edit', instanceId);
  if (peers.length !== 1 || peers[0].role !== 'edit') {
    throw new Error(`${role} needs exactly one edit DataModel, ${peers.length} matched; pass its id from get_connected_instances`);
  }
  return peers[0];
}

export async function copyInstances(host: ForkHost, body: Record<string, unknown>, instanceId: string | undefined): Promise<ForkToolResult> {
  const paths = pathList(body.instance_paths);
  const parentPath = body.parent_path;
  if (typeof parentPath !== 'string' || parentPath === '') throw new Error('parent_path is required');
  const name = body.name;
  if (name !== undefined && (typeof name !== 'string' || name === '' || name.length > 100)) {
    throw new Error('name must be a non-empty string of at most 100 characters');
  }
  if (name !== undefined && paths.length !== 1) throw new Error('name renames a single copy, so pass one instance path with it');
  const sourceId = body.source_instance_id;
  if (sourceId !== undefined && typeof sourceId !== 'string') throw new Error('source_instance_id must be a string');

  // Both ends are resolved before anything is read, so a wrong id fails without serializing anything.
  const source = await editPeer(host, sourceId ?? instanceId, 'source');
  const destination = await editPeer(host, instanceId, 'destination');

  const exported = await host.requestPeer(EXPORT, { instance_paths: paths }, source.peerId, COPY_TIMEOUT_MS) as {
    error?: unknown;
    base64?: unknown;
  } | undefined;
  if (!exported || typeof exported !== 'object') throw new Error('source Studio returned no copy');
  if (typeof exported.error === 'string') throw new Error(`could not copy from the source: ${exported.error}`);
  if (typeof exported.base64 !== 'string' || exported.base64 === '') throw new Error('source Studio returned an empty copy');

  const reply = luauValue(await host.requestPeer(
    EXECUTE,
    { code: copyInstancesLuau({ base64: exported.base64, parent_path: parentPath, name }) },
    destination.peerId,
    COPY_TIMEOUT_MS,
  ));
  return toolText({
    ...reply,
    bytes: Buffer.byteLength(exported.base64, 'base64'),
    ...(source.peerId === destination.peerId ? {} : { from: sourceId }),
  });
}

export async function moveInstances(host: ForkHost, body: Record<string, unknown>, instanceId: string | undefined): Promise<ForkToolResult> {
  const paths = pathList(body.instance_paths);
  const offset = vector(body.offset, 'offset');
  const to = vector(body.to, 'to');
  const rotation = vector(body.rotation, 'rotation');
  const origin = vector(body.origin, 'origin');
  if (offset && to) throw new Error('pass offset or to, not both');
  if (!offset && !to && !rotation) throw new Error('pass offset, to or rotation');
  if (origin && !rotation) throw new Error('origin only applies with rotation');

  const peer = await editPeer(host, instanceId, 'move_instances');
  const reply = luauValue(await host.requestPeer(
    EXECUTE,
    { code: moveInstancesLuau({ paths, offset, to, rotation, origin }) },
    peer.peerId,
    MOVE_TIMEOUT_MS,
  ));
  return toolText(reply);
}

const COPY_DEFINITION: ToolDefinition = {
  name: 'copy_instances',
  category: 'write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  description: 'Use to copy instances between two open places, or within one, in one undo step without an rbxm file.',
  inputSchema: {
    type: 'object',
    properties: {
      instance_paths: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Instances to copy from the source place.' },
      parent_path: { type: 'string', description: 'Parent to copy them under in the destination place.' },
      name: { type: 'string', description: 'New name for the copy, when copying one instance.' },
      source_instance_id: { type: 'string', description: 'Studio process to copy from, defaults to instance_id.' },
      instance_id: { type: 'string', description: 'Studio process to copy into, when several are open.' },
    },
    required: ['instance_paths', 'parent_path'],
  },
};

const MOVE_DEFINITION: ToolDefinition = {
  name: 'move_instances',
  category: 'write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  description: 'Use to move or turn instances, Folders included, by an offset or to a point, in one undo step.',
  inputSchema: {
    type: 'object',
    properties: {
      instance_paths: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Instances to move, a Folder moves everything inside.' },
      offset: point('Studs to move by, as [x, y, z].'),
      to: point('Put the bounding box centre here instead of an offset.'),
      rotation: point('Degrees [x, y, z] to turn by, applied before moving.'),
      origin: point('Point to turn about, defaults to the bounding box centre.'),
      instance_id: { type: 'string', description: 'Studio process ID when ambiguous.' },
    },
    required: ['instance_paths'],
  },
};

const GUIDE = `
## Copying and moving

- copy_instances copies instances from one open place into another without a file, as one Ctrl+Z step named "MCP: copy instances" in the destination.
- Pass source_instance_id for the place to copy from and instance_id for the place to copy into, both as listed by get_connected_instances, or only instance_id to copy within one place.
- Pass name when copying one instance under a parent that already has a child of that name, since paths resolve to the first child with a name.
- Each copy reports same_named_siblings when it shares its name with other children, a sign its path may resolve to one of those instead.
- move_instances moves Models, parts and Folders as one Ctrl+Z step named "MCP: move instances", and a Folder carries everything inside it.
- offset moves by studs, to puts the bounding box centre of everything moved at a point, and rotation turns everything in degrees about origin, the bounding box centre by default, before it moves.
- Welded parts stay together, Models with a PrimaryPart follow it and other Models keep their pivot in the same place relative to their parts.
- Only parts and Model pivots move, so a Camera or another world space value inside the moved instances keeps its old position.
`;

export const transferFeature: ForkFeature = {
  name: 'transfer',
  definitions: [COPY_DEFINITION, MOVE_DEFINITION],
  handlers: {
    copy_instances: (tools, body) => copyInstances(tools.forkHost, body, body.instance_id as string | undefined),
    move_instances: (tools, body) => moveInstances(tools.forkHost, body, body.instance_id as string | undefined),
  },
  instructions: [{
    tools: ['copy_instances', 'move_instances'],
    text: 'Use copy_instances to move content between open places instead of export_rbxm and import_rbxm, and move_instances to shift whole Folders.',
  }],
  guide: GUIDE,
};
