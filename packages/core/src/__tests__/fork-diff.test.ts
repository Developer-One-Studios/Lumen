import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { publicToolDefinition } from '../mcp-runtime.js';
import type { ForkHost, PeerTarget } from '../tools/fork-tools.js';
import { compareIndexes, diffFeature, diffInstances, propertyChanges, topmost } from '../tools/fork/diff.js';
import { diffDetailLuau, diffIndexLuau } from '../tools/fork/diff-luau.js';

type Call = { endpoint: string; data: Record<string, unknown>; peerId: string };

const ok = (value: unknown) => ({ success: true, returnValue: JSON.stringify(value) });
const body = (result: { content: Array<{ text?: string }> }) => JSON.parse(result.content[0].text!);

function args(code: string): Record<string, unknown> {
  const match = /JSONDecode\(\[(=*)\[\n([\s\S]*?)\]\1\]\)/.exec(code);
  return match ? JSON.parse(match[2]) : {};
}

function fakeHost(peers: Record<string, PeerTarget[]>, reply: (call: Call) => unknown) {
  const calls: Call[] = [];
  const host: ForkHost = {
    peerTargets: async (_target, instanceId) => peers[instanceId ?? ''] ?? [],
    requestPeer: async (endpoint, data, peerId) => {
      const call = { endpoint, data: data as Record<string, unknown>, peerId };
      calls.push(call);
      return reply(call);
    },
    soloPlaytest: async () => ({ content: [] }),
    getRuntimeLogs: async () => ({ content: [] }),
  };
  return { host, calls };
}

const entry = (path: string, className: string, fingerprint: string) => ({ path, className, fingerprint });

describe('diff_instances comparison', () => {
  test('matches by relative path and sorts every instance into one bucket', () => {
    const a = [entry('', 'Model', 'r'), entry('VFX', 'Folder', 'f'), entry('VFX/Beam', 'Beam', '1'), entry('Old', 'Part', 'o'), entry('Old/Weld', 'Weld', 'w'), entry('Cam', 'Model', 'c')];
    const b = [entry('', 'Folder', 'r2'), entry('VFX', 'Folder', 'f'), entry('VFX/Beam', 'Beam', '2'), entry('New', 'Part', 'n'), entry('Cam', 'Part', 'c')];
    expect(compareIndexes(a, b)).toEqual({
      same: 1,
      missing: ['Old', 'Old/Weld'],
      extra: ['New'],
      classChanged: [{ path: '', a: 'Model', b: 'Folder' }, { path: 'Cam', a: 'Model', b: 'Part' }],
      changed: [{ path: 'VFX/Beam', className: 'Beam' }],
    });
  });

  test('lists the topmost of nested paths with how many instances each stands for', () => {
    expect(topmost(['VFX/End', 'VFX/End/BG', 'VFX/End/BG/Point', 'Map', 'VFX/Endless'])).toEqual([
      { path: 'Map', instances: 1 },
      { path: 'VFX/End', instances: 3 },
      { path: 'VFX/Endless', instances: 1 },
    ]);
  });

  test('reports only properties whose values differ, with a missing side as null', () => {
    expect(propertyChanges({ Enabled: 'true', Width0: '12', '@Emit': '5' }, { Enabled: 'false', Width0: '12', Color: '1' })).toEqual({
      '@Emit': ['5', null],
      Color: [null, '1'],
      Enabled: ['true', 'false'],
    });
  });
});

describe('diff_instances tool', () => {
  const STUDIOS = { artist: [{ role: 'edit', peerId: 'p-artist' }], game: [{ role: 'edit', peerId: 'p-game' }] };

  test('indexes both places, details only the changed instances, and reads nothing twice', async () => {
    const { host, calls } = fakeHost(STUDIOS, (call) => {
      const code = String(call.data.code);
      const fromArtist = call.peerId === 'p-artist';
      if (code.includes('fingerprint(describe(instance))')) {
        return ok({
          root: fromArtist ? 'game.Workspace' : 'game.ReplicatedStorage.Sets.Madara',
          entries: fromArtist
            ? [['', 'Workspace', 'w'], ['VFX', 'Folder', 'f'], ['VFX/DarkCircle', 'MeshPart', 'a'], ['Baseplate', 'Part', 'b']]
            : [['', 'Model', 'm'], ['VFX', 'Folder', 'f'], ['VFX/DarkCircle', 'MeshPart', 'z']],
        });
      }
      return ok({ details: { 'VFX/DarkCircle': fromArtist ? { Transparency: '1', Color: '0, 0, 0' } : { Transparency: '0', Color: '0, 0, 0' } } });
    });
    const result = body(await diffInstances(host, {
      a_path: 'game.Workspace',
      b_path: 'game.ReplicatedStorage.Sets.Madara',
      a_instance_id: 'artist',
      b_instance_id: 'game',
    }, undefined));

    expect(calls).toHaveLength(4);
    expect(args(String(calls[0].data.code))).toMatchObject({ root_path: 'game.Workspace', ignore_classes: ['KeyframeSequence'], ignore_names: ['AnimSaves'] });
    expect(args(String(calls[2].data.code))).toMatchObject({ paths: ['VFX/DarkCircle'] });
    expect(result).toMatchObject({
      identical: false,
      same: 1,
      only_in_a: { instances: 1, items: [{ path: 'Baseplate', instances: 1 }] },
      only_in_b: { instances: 0 },
      class_changed: { count: 1, items: [{ path: '', a: 'Workspace', b: 'Model' }] },
      changed: { count: 1, items: [{ path: 'VFX/DarkCircle', class: 'MeshPart', differences: { Transparency: ['1', '0'] } }] },
    });
  });

  test('identical trees skip the detail pass', async () => {
    const { host, calls } = fakeHost({ '': [{ role: 'edit', peerId: 'only' }] }, () => ok({ root: 'game.Workspace.A', entries: [['', 'Folder', 'x']] }));
    const result = body(await diffInstances(host, { a_path: 'game.Workspace.A', b_path: 'game.Workspace.B' }, undefined));
    expect(calls).toHaveLength(2);
    expect(result.identical).toBe(true);
  });

  test('refuses bad arguments and an ambiguous Studio before reading anything', async () => {
    const { host, calls } = fakeHost({ two: [{ role: 'edit', peerId: 'a' }, { role: 'edit', peerId: 'b' }] }, () => ok({}));
    await expect(diffInstances(host, { a_path: 'game.Workspace' }, undefined)).rejects.toThrow('a_path and b_path are required');
    await expect(diffInstances(host, { a_path: 'x', b_path: 'y', ignore_names: [1] }, undefined)).rejects.toThrow('ignore_names must be an array of strings');
    await expect(diffInstances(host, { a_path: 'x', b_path: 'y' }, 'two')).rejects.toThrow('exactly one edit DataModel, 2 matched');
    expect(calls).toHaveLength(0);
  });

  test('its catalog entry follows the tool contract', () => {
    const [definition] = diffFeature.definitions.map(publicToolDefinition);
    expect(definition.description.length).toBeLessThanOrEqual(120);
    expect(definition.annotations.readOnlyHint).toBe(true);
  });
});

const compiler = spawnSync('luau-compile', ['--help']).error ? undefined : 'luau-compile';
const SHARED = { root_path: 'game.Workspace', ignore_classes: [], ignore_names: [], ignore_properties: [] };
const SNIPPETS: Record<string, string> = {
  index: diffIndexLuau({ ...SHARED, max_instances: 10 }),
  detail: diffDetailLuau({ ...SHARED, paths: ['VFX/Beam#2'] }),
};

describe('diff Luau snippets', () => {
  (compiler ? test.each(Object.entries(SNIPPETS)) : test.skip.each(Object.entries(SNIPPETS)))('%s compiles as Luau', (name, code) => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fork-diff-')), `${name}.luau`);
    fs.writeFileSync(file, code);
    const result = spawnSync(compiler!, ['--null', file], { encoding: 'utf8' });
    expect(result.stderr + result.stdout).not.toMatch(/error/i);
    expect(result.status).toBe(0);
  });
});
