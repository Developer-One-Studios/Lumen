import { readRbxmInput } from '../../rbxm-input.js';
import type { ToolDefinition } from '../definitions.js';
import { clamp, luauValue, toolText, type ForkHost } from '../fork-tools.js';
import type { ForkFeature, ForkToolResult } from './feature.js';
import { inspectRbxmLuau } from './inspect-rbxm-luau.js';

const EXECUTE = '/api/execute-luau';
// Reading a large delivery and walking every descendant twice yields for a while.
const INSPECT_TIMEOUT_MS = 120_000;
const DEFAULT_DEPTH = 2;
const MAX_DEPTH = 8;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  return value;
}

export async function inspectRbxm(
  host: ForkHost,
  body: Record<string, unknown>,
  instanceId: string | undefined,
  signal?: AbortSignal,
): Promise<ForkToolResult> {
  const source = body.source;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('source is required, for example {"path": "/path/to/file.rbxm"}');
  }
  const root = optionalString(body.root, 'root');
  const matchIn = optionalString(body.match_in, 'match_in');
  if (body.assets !== undefined && typeof body.assets !== 'boolean') throw new Error('assets must be a boolean');

  const peers = await host.peerTargets('edit', instanceId);
  if (peers.length !== 1 || peers[0].role !== 'edit') {
    throw new Error(`inspect_rbxm reads the file in an edit DataModel, ${peers.length} matched; pass its id from get_connected_instances`);
  }
  // The same reader and size cap as import_rbxm, so a file that inspects also imports.
  const { bytes, sourceLabel } = await readRbxmInput(source as { path?: string; url?: string; base64?: string }, root ?? '', signal);
  const reply = luauValue(await host.requestPeer(
    EXECUTE,
    {
      code: inspectRbxmLuau({
        base64: bytes.toString('base64'),
        root,
        depth: clamp(body.depth, DEFAULT_DEPTH, 0, MAX_DEPTH),
        limit: clamp(body.limit, DEFAULT_LIMIT, 1, MAX_LIMIT),
        assets: body.assets === true,
        match_in: matchIn,
      }),
    },
    peers[0].peerId,
    INSPECT_TIMEOUT_MS,
  ));
  return toolText({ source: sourceLabel, bytes: bytes.length, ...reply });
}

const INSPECT_DEFINITION: ToolDefinition = {
  name: 'inspect_rbxm',
  category: 'write',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  description: 'Use to read an .rbxm file\'s tree, attributes and asset ids, or match it to models, without importing it.',
  inputSchema: {
    type: 'object',
    properties: {
      source: {
        type: 'object',
        description: 'Exactly one path, URL, or base64 source of the .rbxm.',
        properties: {
          path: { type: 'string', description: 'Local .rbxm path, a relative one reads from the artifact folder.' },
          url: { type: 'string', description: 'HTTP or HTTPS .rbxm URL.' },
          base64: { type: 'string', description: 'Base64-encoded .rbxm bytes.' },
        },
      },
      root: { type: 'string', description: 'Slash path inside the file to start at, such as allstuff/Juudara.' },
      depth: { type: 'integer', minimum: 0, maximum: MAX_DEPTH, default: DEFAULT_DEPTH, description: 'Levels listed below the start, deeper ones summed up by class.' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT, description: 'Most instances listed.' },
      assets: { type: 'boolean', description: 'Also list the asset ids it uses, by property, with counts.' },
      match_in: { type: 'string', description: 'Place path whose children each item is matched against.' },
      instance_id: { type: 'string', description: 'Studio process ID when ambiguous.' },
    },
    required: ['source'],
  },
};

const GUIDE = `
## Inspecting an rbxm file

- inspect_rbxm reads an .rbxm the way import_rbxm does, from a path, URL or base64, but only in memory in the edit plugin. Nothing is parented, so the place and its undo history are untouched.
- Prefer it to importing a file just to look inside it, for example an artist's delivery before deciding what to import and where.
- nodes lists instances as slash paths inside the file, from the file's top level or from root, down to depth levels. Each has its class, child count and up to 8 attributes, and one at the last listed level sums up what is inside it by class.
- assets true adds every asset id the file uses by property, such as MeshId, TextureID, ColorMap, Texture, SoundId and AnimationId, with how many instances use each. That shows what the file needs uploaded or shared before it works in game.
- match_in names a place path, such as a folder of unit models. Each item of the file, the children of root or of a single top-level instance, otherwise the top-level instances, is compared with every child of match_in by the meshes and mesh textures they share, and its three best matches are listed with how many ids they share.
- Effect textures are left out of matching because many unrelated effects reuse them, so an item made only of effects matches nothing.
`;

export const inspectRbxmFeature: ForkFeature = {
  name: 'inspect_rbxm',
  definitions: [INSPECT_DEFINITION],
  handlers: {
    inspect_rbxm: (tools, body, context) => inspectRbxm(tools.forkHost, body, body.instance_id as string | undefined, context?.signal),
  },
  instructions: [{
    tools: ['inspect_rbxm', 'import_rbxm'],
    text: 'Use inspect_rbxm to look inside an .rbxm or match its models to the place before importing it.',
  }],
  guide: GUIDE,
};
