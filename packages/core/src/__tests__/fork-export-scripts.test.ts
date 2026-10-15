import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ForkHost, PeerTarget } from '../tools/fork-tools.js';
import { exportScripts, exportScriptsLuau, planScriptFiles } from '../tools/fork/export-scripts.js';

const ok = (value: unknown) => ({ success: true, returnValue: JSON.stringify(value) });
const body = (result: { content: Array<{ text?: string }> }) => JSON.parse(result.content[0].text!);

type Node = { name: string; className: string; runContext?: string; source?: string; children: Node[] };
const moduleNode = (name: string, source: string, children: Node[] = []): Node => ({ name, className: 'ModuleScript', source, children });

function fakeHost(peers: PeerTarget[], reply: () => unknown): ForkHost {
  return {
    peerTargets: async () => peers,
    requestPeer: async () => reply(),
    soloPlaytest: async () => ({ content: [] }),
    getRuntimeLogs: async () => ({ content: [] }),
  };
}

const LIBRARY: Node = moduleNode('Part_Icles', 'return {}', [
  moduleNode('Emit', 'return 1'),
  moduleNode('Lightning', 'return 2', [moduleNode('BoltGen', 'return 3')]),
  { name: 'Runtime', className: 'Folder', children: [{ name: 'Boot', className: 'Script', runContext: 'Legacy', source: 'print(1)', children: [] }] },
  { name: 'Client', className: 'LocalScript', source: 'print(2)', children: [] },
  { name: 'Ui', className: 'Script', runContext: 'Client', source: 'print(3)', children: [] },
  { name: 'Marker', className: 'Part', children: [] },
  moduleNode('Dup', 'a'),
  moduleNode('dup', 'b'),
  moduleNode('bad:name', 'c'),
]);

describe('export_scripts layout', () => {
  test('lays scripts out the way Rojo reads them back and skips what files cannot hold', () => {
    const planned = planScriptFiles(LIBRARY, 'lua');
    expect(planned.files.map((entry) => entry.file).sort()).toEqual([
      'Client.client.lua',
      'Emit.lua',
      'Lightning/BoltGen.lua',
      'Lightning/init.lua',
      'Runtime/Boot.server.lua',
      'Ui.client.lua',
      'init.lua',
    ]);
    expect(planned.files.find((entry) => entry.file === 'Lightning/init.lua')?.source).toBe('return 2');
    expect(planned.skipped.map((entry) => entry.path).sort()).toEqual([
      'Part_Icles.Dup',
      'Part_Icles.Marker',
      'Part_Icles.bad:name',
      'Part_Icles.dup',
    ]);
  });

  test('a lone module root becomes init with the chosen extension', () => {
    expect(planScriptFiles(moduleNode('Hitstop', 'return {}'), 'luau').files).toEqual([{ file: 'init.luau', source: 'return {}' }]);
  });
});

describe('export_scripts tool', () => {
  const editPeer = [{ role: 'edit', peerId: 'edit' }];

  test('writes the files into a new artifact folder and refuses to reuse one', async () => {
    const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'export-scripts-'));
    jest.replaceProperty(process, 'env', { ...process.env, ROBLOX_MCP_ARTIFACT_DIR: artifacts });
    const host = fakeHost(editPeer, () => ok({ root: 'game.ReplicatedStorage.Part_Icles', tree: LIBRARY }));

    const result = body(await exportScripts(host, { instance_path: 'game.ReplicatedStorage.Part_Icles' }, undefined));
    expect(result).toMatchObject({ root: 'game.ReplicatedStorage.Part_Icles', files: 7, folder: path.join(artifacts, 'scripts', 'Part_Icles') });
    expect(fs.readFileSync(path.join(result.folder, 'Lightning', 'BoltGen.lua'), 'utf8')).toBe('return 3');
    expect(result.skipped).toHaveLength(4);

    await expect(exportScripts(host, { instance_path: 'game.ReplicatedStorage.Part_Icles' }, undefined)).rejects.toThrow('already exists');
    await expect(exportScripts(host, { instance_path: 'x', output_dir: '../outside' }, undefined)).rejects.toThrow('outside ROBLOX_MCP_ARTIFACT_DIR');
  });

  test('checks its arguments and the Studio before writing', async () => {
    const host = fakeHost([], () => ok({}));
    await expect(exportScripts(host, {}, undefined)).rejects.toThrow('instance_path is required');
    await expect(exportScripts(host, { instance_path: 'x', extension: 'txt' }, undefined)).rejects.toThrow('extension must be lua or luau');
    await expect(exportScripts(host, { instance_path: 'x' }, undefined)).rejects.toThrow('exactly one edit DataModel');
  });
});

const compiler = spawnSync('luau-compile', ['--help']).error ? undefined : 'luau-compile';

describe('export_scripts Luau', () => {
  (compiler ? test : test.skip)('compiles as Luau', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'export-scripts-luau-')), 'export.luau');
    fs.writeFileSync(file, exportScriptsLuau('game.ReplicatedStorage.Part_Icles'));
    const result = spawnSync(compiler!, ['--null', file], { encoding: 'utf8' });
    expect(result.stderr + result.stdout).not.toMatch(/error/i);
    expect(result.status).toBe(0);
  });
});
