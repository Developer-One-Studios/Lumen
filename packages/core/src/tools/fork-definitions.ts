import type { ToolDefinition } from './definitions.js';

// These run fixed Luau through execute-luau, so they stay out of the read-only
// inspector edition (category write) while still advertising that they change nothing.
const READ_ONLY_PROBE = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const instanceId = { type: 'string', description: 'Studio process ID when ambiguous.' } as const;
const peerTarget = (fallback: string) => ({ type: 'string', description: `server, client-N or edit; defaults to ${fallback}.` });

export const FORK_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'perf_stats',
    category: 'write',
    annotations: READ_ONLY_PROBE,
    description: 'Use to sample frame, GPU, draw call, physics, network and ping stats per peer, optionally per remote.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'all, edit, server or client-N; defaults to all.' },
        duration_ms: { type: 'number', minimum: 500, maximum: 15000, default: 3000, description: 'Sampling window in ms.' },
        sample_ms: { type: 'number', minimum: 50, maximum: 1000, default: 250, description: 'Interval between samples in ms.' },
        remotes: { type: 'boolean', description: 'Also count calls and bytes per RemoteEvent.' },
        top_remotes: { type: 'number', minimum: 1, maximum: 50, default: 10, description: 'Remotes to return, busiest first.' },
        instance_id: instanceId,
      },
    },
  },
  {
    name: 'lag_audit',
    category: 'write',
    annotations: READ_ONLY_PROBE,
    description: 'Use to find costly content: particles, shadows, lights, meshes, physics, streaming and heavy models.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Peer to scan; defaults to edit.' },
        root: { type: 'string', description: 'Subtree to scan; defaults to game.Workspace.' },
        top: { type: 'number', minimum: 1, maximum: 50, default: 10, description: 'Rows per ranked list.' },
        instance_id: instanceId,
      },
    },
  },
  {
    name: 'profile_toggle',
    category: 'write',
    description: 'Use to measure what a content category costs by disabling it in a playtest and comparing stats.',
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['particles', 'shadows', 'lights', 'post_effects', 'gui', 'instance'],
          description: 'What to switch off; it is restored afterwards.',
        },
        path: { type: 'string', description: 'Instance to unparent when category is instance.' },
        target: peerTarget('client-1'),
        duration_ms: { type: 'number', minimum: 500, maximum: 10000, default: 2000, description: 'Sampling per phase in ms.' },
        instance_id: instanceId,
      },
      required: ['category'],
    },
  },
  {
    name: 'leak_check',
    category: 'write',
    description: 'Use to repeat an action in a playtest and report memory, instances or values that keep growing.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Luau run in the game VM once per iteration.' },
        iterations: { type: 'number', minimum: 2, maximum: 50, default: 5, description: 'How many times to run action.' },
        settle_ms: { type: 'number', minimum: 0, maximum: 30000, default: 1500, description: 'Wait after each action before measuring.' },
        watch: {
          type: 'array',
          items: { type: 'string' },
          description: 'Luau number expressions read in the game VM each round.',
        },
        target: peerTarget('server'),
        instance_id: instanceId,
      },
      required: ['action'],
    },
  },
  {
    name: 'replication_diff',
    category: 'write',
    annotations: READ_ONLY_PROBE,
    description: 'Use to compare one instance between the server and each client to find replication bugs.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Canonical path of the instance.' },
        properties: { type: 'array', items: { type: 'string' }, description: 'Properties to compare; common ones by default.' },
        children: { type: 'boolean', description: 'Also compare child names and classes.' },
        tolerance: { type: 'number', minimum: 0, description: 'Numeric tolerance; defaults to 0.05.' },
        instance_id: instanceId,
      },
      required: ['path'],
    },
  },
  {
    name: 'fuzz_remotes',
    category: 'write',
    description: 'Use to fire malformed and spammed payloads at remotes from a client and collect server errors.',
    inputSchema: {
      type: 'object',
      properties: {
        remotes: { type: 'array', items: { type: 'string' }, description: 'Remote paths; defaults to all under root.' },
        root: { type: 'string', description: 'Where to find remotes; defaults to ReplicatedStorage.' },
        max_remotes: { type: 'number', minimum: 1, maximum: 100, default: 20, description: 'Cap on remotes fuzzed.' },
        spam: { type: 'number', minimum: 0, maximum: 1000, default: 50, description: 'Rapid repeat calls per remote.' },
        include_functions: { type: 'boolean', description: 'Also invoke RemoteFunctions.' },
        settle_ms: { type: 'number', minimum: 100, maximum: 10000, default: 750, description: 'Wait for server errors per remote.' },
        target: peerTarget('client-1'),
        instance_id: instanceId,
      },
    },
  },
  {
    name: 'inspect_gui',
    category: 'write',
    annotations: READ_ONLY_PROBE,
    description: "Use to list a client's GUI with screen rects and text, or find what is under a viewport point.",
    inputSchema: {
      type: 'object',
      properties: {
        target: peerTarget('client-1'),
        root: { type: 'string', description: 'Subtree to list; defaults to PlayerGui.' },
        at: {
          type: 'object',
          properties: { x: { type: 'number', description: 'Viewport pixel X.' }, y: { type: 'number', description: 'Viewport pixel Y.' } },
          required: ['x', 'y'],
          description: 'Viewport pixel to hit-test, as in screenshots.',
        },
        text: { type: 'string', description: 'Only rows whose text contains this.' },
        visible_only: { type: 'boolean', description: 'Skip hidden objects; defaults to true.' },
        max_nodes: { type: 'number', minimum: 1, maximum: 1000, default: 150, description: 'Row limit.' },
        instance_id: instanceId,
      },
    },
  },
  {
    name: 'navigate_character',
    category: 'write',
    description: 'Use to walk the local character to a position or instance with pathfinding during a playtest.',
    inputSchema: {
      type: 'object',
      properties: {
        position: {
          type: 'object',
          properties: { x: { type: 'number', description: 'World X.' }, y: { type: 'number', description: 'World Y.' }, z: { type: 'number', description: 'World Z.' } },
          required: ['x', 'y', 'z'],
          description: 'World position to reach.',
        },
        path: { type: 'string', description: 'BasePart, Model or Attachment to reach instead.' },
        speed_multiplier: { type: 'number', minimum: 0.1, maximum: 10, default: 1, description: 'WalkSpeed factor while walking.' },
        timeout_s: { type: 'number', minimum: 1, maximum: 120, default: 20, description: 'Give up after this many seconds.' },
        target: peerTarget('client-1'),
        instance_id: instanceId,
      },
    },
  },
  {
    name: 'multi_edit',
    category: 'write',
    description: 'Use to apply several exact text edits to one script atomically, or to create it.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Canonical script path; created when missing.' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              old_string: { type: 'string', description: 'Exact text; empty sets a new script.' },
              new_string: { type: 'string', description: 'Replacement text.' },
              replace_all: { type: 'boolean', description: 'Replace every occurrence.' },
            },
            required: ['old_string', 'new_string'],
          },
          description: 'Applied in order; all succeed or none apply.',
        },
        class_name: {
          type: 'string',
          enum: ['Script', 'LocalScript', 'ModuleScript'],
          description: 'Class when creating the script.',
        },
        instance_id: instanceId,
      },
      required: ['path', 'edits'],
    },
  },
  {
    name: 'resolve_source',
    category: 'read',
    description: 'Use to map Studio script paths to Rojo files and back through sourcemap.json.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Studio paths to map to files.' },
        files: { type: 'array', items: { type: 'string' }, description: 'Files to map to Studio paths.' },
        project_root: { type: 'string', description: 'Rojo project folder; sticks for later calls.' },
      },
    },
  },
  {
    name: 'run_tests',
    category: 'write',
    description: "Use to run the place's test runner in a solo playtest and collect pass, fail and error lines.",
    inputSchema: {
      type: 'object',
      properties: {
        expected_summaries: { type: 'number', minimum: 1, maximum: 20, default: 1, description: 'Summary lines to wait for, one per runner.' },
        summary_pattern: { type: 'string', description: 'Regex with passed and failed groups.' },
        fail_pattern: { type: 'string', description: 'Regex for a failure line; group 1 is kept.' },
        mode: { type: 'string', enum: ['play', 'run'], description: 'Playtest mode; defaults to play.' },
        timeout_s: { type: 'number', minimum: 5, maximum: 600, default: 60, description: 'Wait for summaries this long.' },
        keep_running: { type: 'boolean', description: 'Leave the playtest running afterwards.' },
        instance_id: instanceId,
      },
    },
  },
  {
    name: 'audit_assets',
    category: 'write',
    annotations: { ...READ_ONLY_PROBE, openWorldHint: true },
    description: 'Use to find animations, audio and other assets that will fail to load in live servers.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'Subtree to scan; defaults to game.' },
        max_assets: { type: 'number', minimum: 1, maximum: 1000, default: 150, description: 'Assets to look up, animations first.' },
        instance_id: instanceId,
      },
    },
  },
  {
    name: 'datastore_read',
    category: 'write',
    annotations: { ...READ_ONLY_PROBE, openWorldHint: true },
    description: 'Use to list DataStores or keys, or read one entry, through Open Cloud; never writes.',
    inputSchema: {
      type: 'object',
      properties: {
        universe_id: { type: 'number', description: "Universe ID; defaults to the open place's game." },
        datastore: { type: 'string', description: 'DataStore name; omit to list stores.' },
        key: { type: 'string', description: 'Entry key; omit to list keys.' },
        prefix: { type: 'string', description: 'Name or key prefix filter.' },
        scope: { type: 'string', description: 'DataStore scope; defaults to global.' },
        limit: { type: 'number', minimum: 1, maximum: 100, default: 20, description: 'Page size for lists.' },
        cursor: { type: 'string', description: 'Next page cursor from a previous list.' },
        instance_id: instanceId,
      },
    },
  },
];
