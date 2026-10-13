import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { publicToolDefinition } from '../mcp-runtime.js';
import type { ForkHost, PeerTarget } from '../tools/fork-tools.js';
import { copyInstancesLuau, moveInstancesLuau } from '../tools/fork/transfer-luau.js';
import { copyInstances, moveInstances, transferFeature } from '../tools/fork/transfer.js';

type Call = { endpoint: string; data: Record<string, unknown>; peerId: string; timeoutMs?: number };

const ok = (value: unknown) => ({ success: true, returnValue: JSON.stringify(value) });
const body = (result: { content: Array<{ text?: string }> }) => JSON.parse(result.content[0].text!);

function args(code: string): Record<string, unknown> {
  const match = /JSONDecode\(\[(=*)\[\n([\s\S]*?)\]\1\]\)/.exec(code);
  return match ? JSON.parse(match[2]) : {};
}

function fakeHost(peers: Record<string, PeerTarget[]>, reply: (call: Call) => unknown) {
  const calls: Call[] = [];
  const targets: Array<{ target?: string; instanceId?: string }> = [];
  const host: ForkHost = {
    peerTargets: async (target, instanceId) => {
      targets.push({ target, instanceId });
      return peers[instanceId ?? ''] ?? [];
    },
    requestPeer: async (endpoint, data, peerId, timeoutMs) => {
      const call = { endpoint, data: data as Record<string, unknown>, peerId, timeoutMs };
      calls.push(call);
      return reply(call);
    },
    soloPlaytest: async () => ({ content: [] }),
    getRuntimeLogs: async () => ({ content: [] }),
  };
  return { host, calls, targets };
}

const STUDIOS = {
  '': [{ role: 'edit', peerId: 'only' }],
  final: [{ role: 'edit', peerId: 'p-final' }],
  game: [{ role: 'edit', peerId: 'p-game' }],
  running: [{ role: 'server', peerId: 'p-server' }],
};

const COPIED = { parent: 'game.Workspace', count: 1, copied: [{ path: 'game.Workspace.Map', class: 'Folder', descendants: 3 }] };

describe('copy_instances', () => {
  test('exports from the source Studio and rebuilds in the destination', async () => {
    const { host, calls, targets } = fakeHost(STUDIOS, (call) => (
      call.endpoint === '/api/export-rbxm' ? { base64: 'cmJ4bQ==', instance_count: 1 } : ok(COPIED)
    ));
    const result = body(await copyInstances(host, {
      instance_paths: ['game.Workspace.Map'],
      parent_path: 'game.Workspace',
      source_instance_id: 'final',
      name: 'Map',
    }, 'game'));

    expect(targets).toEqual([{ target: 'edit', instanceId: 'final' }, { target: 'edit', instanceId: 'game' }]);
    expect(calls.map((call) => [call.endpoint, call.peerId])).toEqual([
      ['/api/export-rbxm', 'p-final'],
      ['/api/execute-luau', 'p-game'],
    ]);
    expect(calls[0].data).toEqual({ instance_paths: ['game.Workspace.Map'] });
    expect(args(calls[1].data.code as string)).toEqual({ base64: 'cmJ4bQ==', parent_path: 'game.Workspace', name: 'Map' });
    expect(result).toEqual({ ...COPIED, bytes: 4, from: 'final' });
  });

  test('copies within one Studio when no source is named', async () => {
    const { host, calls } = fakeHost(STUDIOS, (call) => (
      call.endpoint === '/api/export-rbxm' ? { base64: 'cmJ4bQ==' } : ok(COPIED)
    ));
    const result = body(await copyInstances(host, { instance_paths: ['game.Workspace.Map'], parent_path: 'game.Workspace' }, undefined));
    expect(calls.map((call) => call.peerId)).toEqual(['only', 'only']);
    expect(result.from).toBeUndefined();
  });

  test('a failed export never reaches the destination', async () => {
    const { host, calls } = fakeHost(STUDIOS, () => ({ error: 'Instance not found: game.Workspace.Nope' }));
    await expect(copyInstances(host, { instance_paths: ['game.Workspace.Nope'], parent_path: 'game.Workspace' }, 'game'))
      .rejects.toThrow('could not copy from the source: Instance not found');
    expect(calls).toHaveLength(1);
  });

  test('destination errors from Luau surface as tool errors', async () => {
    const { host } = fakeHost(STUDIOS, (call) => (
      call.endpoint === '/api/export-rbxm' ? { base64: 'cmJ4bQ==' } : ok({ error: 'copy_instances found no destination parent at game.Nope' })
    ));
    await expect(copyInstances(host, { instance_paths: ['game.Workspace.Map'], parent_path: 'game.Nope' }, 'game'))
      .rejects.toThrow('found no destination parent');
  });

  test('refuses running DataModels and unknown Studios before reading anything', async () => {
    const { host, calls } = fakeHost(STUDIOS, () => ok(COPIED));
    await expect(copyInstances(host, { instance_paths: ['game.Workspace.Map'], parent_path: 'game.Workspace' }, 'running'))
      .rejects.toThrow('exactly one edit DataModel');
    await expect(copyInstances(host, { instance_paths: ['game.Workspace.Map'], parent_path: 'game.Workspace', source_instance_id: 'gone' }, 'game'))
      .rejects.toThrow('source needs exactly one edit DataModel, 0 matched');
    expect(calls).toHaveLength(0);
  });

  test.each([
    [{ instance_paths: [], parent_path: 'game.Workspace' }, 'instance_paths'],
    [{ instance_paths: ['game.Workspace.Map', 3], parent_path: 'game.Workspace' }, 'instance_paths'],
    [{ instance_paths: ['game.Workspace.Map'] }, 'parent_path'],
    [{ instance_paths: ['game.Workspace.Map'], parent_path: 'game.Workspace', name: '' }, 'name'],
    [{ instance_paths: ['game.Workspace.A', 'game.Workspace.B'], parent_path: 'game.Workspace', name: 'C' }, 'pass one instance path'],
    [{ instance_paths: ['game.Workspace.Map'], parent_path: 'game.Workspace', source_instance_id: 4 }, 'source_instance_id'],
  ])('rejects bad arguments %j', async (input, message) => {
    const { host, calls } = fakeHost(STUDIOS, () => ok(COPIED));
    await expect(copyInstances(host, input, undefined)).rejects.toThrow(message);
    expect(calls).toHaveLength(0);
  });
});

describe('move_instances', () => {
  const MOVED = { moved: ['game.Workspace.Map'], roots: 1, parts: 2, shift: [10, 0, 0] };

  test('sends one snippet to the edit DataModel', async () => {
    const { host, calls } = fakeHost(STUDIOS, () => ok(MOVED));
    const result = body(await moveInstances(host, {
      instance_paths: ['game.Workspace.Map'],
      to: [0, 5, 0],
      rotation: [0, 90, 0],
      origin: [1, 2, 3],
    }, 'game'));
    expect(calls).toHaveLength(1);
    expect(calls[0].peerId).toBe('p-game');
    expect(args(calls[0].data.code as string)).toEqual({
      paths: ['game.Workspace.Map'],
      to: [0, 5, 0],
      rotation: [0, 90, 0],
      origin: [1, 2, 3],
    });
    expect(result).toEqual(MOVED);
  });

  test.each([
    [{ instance_paths: ['game.Workspace.Map'] }, 'pass offset, to or rotation'],
    [{ instance_paths: ['game.Workspace.Map'], offset: [1, 0, 0], to: [0, 0, 0] }, 'offset or to, not both'],
    [{ instance_paths: ['game.Workspace.Map'], offset: [1, 0, 0], origin: [0, 0, 0] }, 'origin only applies with rotation'],
    [{ instance_paths: ['game.Workspace.Map'], offset: [1, 0] }, 'offset must be three finite numbers'],
    [{ instance_paths: ['game.Workspace.Map'], offset: [1, 0, null] }, 'offset must be three finite numbers'],
    [{ instance_paths: 'game.Workspace.Map', offset: [1, 0, 0] }, 'instance_paths'],
  ])('rejects bad arguments %j', async (input, message) => {
    const { host, calls } = fakeHost(STUDIOS, () => ok(MOVED));
    await expect(moveInstances(host, input, undefined)).rejects.toThrow(message);
    expect(calls).toHaveLength(0);
  });

  test('refuses a running DataModel', async () => {
    const { host } = fakeHost(STUDIOS, () => ok(MOVED));
    await expect(moveInstances(host, { instance_paths: ['game.Workspace.Map'], offset: [1, 0, 0] }, 'running'))
      .rejects.toThrow('exactly one edit DataModel');
  });
});

describe('transfer feature', () => {
  test('registers both tools with routing, guide and catalog budget', () => {
    expect(transferFeature.definitions.map((definition) => definition.name)).toEqual(['copy_instances', 'move_instances']);
    for (const definition of transferFeature.definitions) {
      expect((definition.inputSchema as { properties: object }).properties).toHaveProperty('instance_id');
      expect(String(transferFeature.handlers[definition.name])).toContain('body.instance_id');
      expect(JSON.stringify(publicToolDefinition(definition)).length).toBeLessThanOrEqual(1400);
    }
    expect(transferFeature.guide).toMatch(/^\s*## Copying and moving/);
    expect(transferFeature.guide).not.toMatch(/[—–;]/);
  });
});

const compiler = spawnSync('luau-compile', ['--help']).error ? undefined : 'luau-compile';

const SNIPPETS: Record<string, string> = {
  copy: copyInstancesLuau({ base64: 'cmJ4bQ==', parent_path: 'game.Workspace', name: 'Map' }),
  move: moveInstancesLuau({ paths: ['game.Workspace.Map'], offset: [1, 2, 3], rotation: [0, 90, 0], origin: [0, 0, 0] }),
};

describe('transfer Luau snippets', () => {
  (compiler ? test.each(Object.entries(SNIPPETS)) : test.skip.each(Object.entries(SNIPPETS)))('%s compiles as Luau', (name, code) => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fork-transfer-')), `${name}.luau`);
    fs.writeFileSync(file, code);
    const result = spawnSync(compiler!, ['--null', file], { encoding: 'utf8' });
    expect(result.stderr + result.stdout).not.toMatch(/error/i);
    expect(result.status).toBe(0);
  });
});
