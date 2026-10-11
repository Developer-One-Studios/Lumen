import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SourcemapResolver, starterPath, type RojoRunner, type SourcemapNode } from '../sourcemap.js';
import { SOURCE_HASH_LUAU, sourceHash, syncFeature, verifySync, verifySyncLuau } from '../tools/fork/sync.js';
import type { PeerTarget } from '../tools/fork-tools.js';

const available = (command: string) => !spawnSync(command, ['--help']).error;
const hasLuau = available('luau');
const hasCompiler = available('luau-compile');
const hasRojo = available('rojo');

const PROJECT = {
  name: 'Fixture',
  tree: {
    $className: 'DataModel',
    ServerScriptService: { $path: 'src/server' },
    StarterPlayer: { StarterPlayerScripts: { $path: 'src/client' } },
    ReplicatedStorage: { Shared: { $path: 'src/shared' } },
  },
};

const FILES: Record<string, string> = {
  'src/server/Main.server.luau': 'print("main v2")\r\n',
  'src/server/Combat/Damage.luau': 'return 42\n',
  'src/client/Input.client.luau': '﻿print("input")\n',
  'src/shared/Util.luau': 'return {}',
};

// What rojo prints for PROJECT and FILES, plus a script whose file was deleted since.
const SOURCEMAP: SourcemapNode = {
  name: 'Fixture',
  className: 'DataModel',
  children: [
    {
      name: 'ServerScriptService',
      className: 'ServerScriptService',
      children: [
        { name: 'Combat', className: 'Folder', children: [{ name: 'Damage', className: 'ModuleScript', filePaths: ['src/server/Combat/Damage.luau'] }] },
        { name: 'Main', className: 'Script', filePaths: ['src/server/Main.server.luau'] },
        { name: 'Removed', className: 'Script', filePaths: ['src/server/Removed.server.luau'] },
      ],
    },
    {
      name: 'StarterPlayer',
      className: 'StarterPlayer',
      children: [{
        name: 'StarterPlayerScripts',
        className: 'StarterPlayerScripts',
        children: [{ name: 'Input', className: 'LocalScript', filePaths: ['src/client/Input.client.luau'] }],
      }],
    },
    {
      name: 'ReplicatedStorage',
      className: 'ReplicatedStorage',
      children: [{ name: 'Shared', className: 'Folder', children: [{ name: 'Util', className: 'ModuleScript', filePaths: ['src/shared/Util.luau'] }] }],
    },
  ],
};

const MAIN = 'game.ServerScriptService.Main';
const DAMAGE = 'game.ServerScriptService.Combat.Damage';
const REMOVED = 'game.ServerScriptService.Removed';
const INPUT = 'game.StarterPlayer.StarterPlayerScripts.Input';
const UTIL = 'game.ReplicatedStorage.Shared.Util';

function setMtime(file: string, secondsFromNow: number) {
  const time = new Date(Date.now() + secondsFromNow * 1000);
  fs.utimesSync(file, time, time);
}

function fixture(options: { project?: boolean; sourcemap?: boolean } = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-sync-'));
  for (const [file, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  if (options.project !== false) {
    fs.writeFileSync(path.join(root, 'default.project.json'), JSON.stringify(PROJECT));
    setMtime(path.join(root, 'default.project.json'), -60);
  }
  if (options.sourcemap !== false) fs.writeFileSync(path.join(root, 'sourcemap.json'), JSON.stringify(SOURCEMAP));
  return root;
}

function fakeRojo(output: SourcemapNode = SOURCEMAP) {
  const calls: string[] = [];
  const run: RojoRunner = async (project) => {
    calls.push(project);
    return JSON.stringify(output);
  };
  return { calls, run };
}

function luauString(bytes: Buffer): string {
  return `"${[...bytes].map((byte) => `\\${String(byte).padStart(3, '0')}`).join('')}"`;
}

describe('source hashing', () => {
  test('is FNV-1a 32 over the normalized bytes', () => {
    expect(sourceHash(Buffer.from('')).hash).toBe('811c9dc5');
    expect(sourceHash(Buffer.from('a')).hash).toBe('e40c292c');
    expect(sourceHash(Buffer.from('foobar')).hash).toBe('bf9cf968');
  });

  test('ignores a BOM, CRLF and one final newline, nothing else', () => {
    const plain = sourceHash(Buffer.from('a\nb'));
    expect(sourceHash(Buffer.from('﻿a\r\nb\r\n'))).toEqual(plain);
    expect(sourceHash(Buffer.from('a\nb\n'))).toEqual(plain);
    expect(sourceHash(Buffer.from('a\nb\n\n'))).not.toEqual(plain);
    expect(sourceHash(Buffer.from('a\rb'))).not.toEqual(plain);
    expect(plain.bytes).toBe(3);
  });

  (hasLuau ? test : test.skip)('the Luau hash matches the TypeScript hash byte for byte', () => {
    let seed = 12345;
    const random = Buffer.alloc(65_536);
    for (let i = 0; i < random.length; i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      random[i] = seed >> 16 & 0xff;
    }
    const cases = [
      Buffer.from(''),
      Buffer.from('a'),
      Buffer.from('foobar'),
      Buffer.from('line\r\nline\r\n'),
      Buffer.from('﻿bom\n'),
      Buffer.from('a\n\n'),
      Buffer.from('\r'),
      Buffer.from(Array.from({ length: 256 }, (_, byte) => byte)),
      random,
    ];
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fork-sync-luau-')), 'hash.luau');
    fs.writeFileSync(file, `${SOURCE_HASH_LUAU}
local cases = { ${cases.map(luauString).join(', ')} }
for _, case in cases do
	local hash, bytes = hashSource(case)
	print(hash .. " " .. bytes)
end
`);
    const result = spawnSync('luau', [file], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    expect(result.stderr).toBe('');
    expect(result.stdout.trim().split('\n')).toEqual(cases.map((data) => {
      const digest = sourceHash(data);
      return `${digest.hash} ${digest.bytes}`;
    }));
  });

  (hasCompiler ? test.each(['edit', 'server', 'client'] as const) : test.skip.each(['edit', 'server', 'client'] as const))(
    'the %s snippet compiles as Luau',
    (role) => {
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fork-sync-luau-')), `${role}.luau`);
      fs.writeFileSync(file, verifySyncLuau({ role, paths: [MAIN, 'game.Workspace["odd ]] name"]'], hashes: ['811c9dc5', 'e40c292c'] }));
      const result = spawnSync('luau-compile', ['--null', file], { encoding: 'utf8' });
      expect(result.stderr + result.stdout).not.toMatch(/error/i);
      expect(result.status).toBe(0);
    },
  );
});

describe('sourcemap regeneration', () => {
  test('rebuilds a missing map in memory and caches it until the project changes', async () => {
    const root = fixture({ sourcemap: false });
    const project = path.join(root, 'default.project.json');
    const rojo = fakeRojo();
    const resolver = new SourcemapResolver(() => path.join(root, 'src'), { runRojo: rojo.run, autoRefresh: false });
    expect(resolver.current()).toBeUndefined();

    const first = await resolver.refresh();
    expect(first).toMatchObject({ rebuilt: true, stale: 'no sourcemap.json' });
    expect(rojo.calls).toEqual([project]);
    expect(resolver.current()?.generatedFrom).toBe(project);
    expect(resolver.fileForPath(MAIN)).toBe(path.join(root, 'src/server/Main.server.luau'));
    expect(resolver.displayFile(path.join(root, 'src/shared/Util.luau'))).toBe(path.join('src', 'shared', 'Util.luau'));

    expect((await resolver.refresh()).rebuilt).toBeUndefined();
    expect(rojo.calls).toHaveLength(1);

    setMtime(project, 5);
    expect((await resolver.refresh()).stale).toMatch(/default\.project\.json changed/);
    expect((await resolver.refresh(true)).stale).toBe('regenerate requested');
    expect(rojo.calls).toHaveLength(3);
    expect(fs.existsSync(path.join(root, 'sourcemap.json'))).toBe(false);
  });

  test('trusts a fresh sourcemap.json and rebuilds one older than the max age', async () => {
    const root = fixture();
    const sourcemap = path.join(root, 'sourcemap.json');
    setMtime(path.join(root, 'default.project.json'), -5000);
    const rojo = fakeRojo();
    const resolver = new SourcemapResolver(() => root, { runRojo: rojo.run, autoRefresh: false, env: {} });
    const fresh = await resolver.refresh();
    expect(fresh.index?.sourcemapPath).toBe(sourcemap);
    expect(rojo.calls).toHaveLength(0);

    setMtime(sourcemap, -1000);
    const patient = new SourcemapResolver(() => root, { runRojo: rojo.run, autoRefresh: false, env: { ROBLOX_SOURCEMAP_MAX_AGE_S: '5000' } });
    expect((await patient.refresh()).rebuilt).toBeUndefined();
    expect(rojo.calls).toHaveLength(0);

    const stale = await resolver.refresh();
    expect(stale).toMatchObject({ rebuilt: true, stale: 'the map is over 300s old' });
    expect(stale.index?.generatedFrom).toBe(path.join(root, 'default.project.json'));
    expect(resolver.current()).toBe(stale.index);
  });

  test('falls back to sourcemap.json and says why when rojo fails', async () => {
    const root = fixture();
    setMtime(path.join(root, 'sourcemap.json'), -1000);
    const resolver = new SourcemapResolver(() => root, {
      runRojo: async () => { throw new Error('rojo is not on PATH'); },
      autoRefresh: false,
      env: {},
    });
    const result = await resolver.refresh();
    expect(result.error).toBe('rojo is not on PATH');
    expect(result.rebuilt).toBeUndefined();
    expect(result.index?.sourcemapPath).toBe(path.join(root, 'sourcemap.json'));
    expect(resolver.fileForPath(DAMAGE)).toBe(path.join(root, 'src/server/Combat/Damage.luau'));
  });

  test('a stale lookup starts one background rebuild that refresh() joins', async () => {
    const root = fixture({ sourcemap: false });
    let release!: () => void;
    let calls = 0;
    const resolver = new SourcemapResolver(() => root, {
      runRojo: async () => {
        calls += 1;
        await new Promise<void>((resolve) => { release = resolve; });
        return JSON.stringify(SOURCEMAP);
      },
    });
    expect(resolver.current()).toBeUndefined();
    expect(resolver.current()).toBeUndefined();
    const joined = resolver.refresh();
    release();
    expect((await joined).rebuilt).toBe(true);
    expect(calls).toBe(1);
    expect(resolver.current()?.byPath.get(UTIL)).toBe(path.join(root, 'src/shared/Util.luau'));
  });

  test('a rebuild started for another project never answers a refresh for the new root', async () => {
    const first = fixture({ sourcemap: false });
    const second = fixture({ sourcemap: false });
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const resolver = new SourcemapResolver(() => first, {
      env: {},
      runRojo: async (project) => {
        calls.push(project);
        if (calls.length === 1) await gate;
        return JSON.stringify(SOURCEMAP);
      },
    });
    expect(resolver.current()).toBeUndefined();
    resolver.setProjectRoot(second);
    const answer = resolver.refresh();
    release();
    expect((await answer).index?.generatedFrom).toBe(path.join(second, 'default.project.json'));
    expect(calls).toEqual([path.join(first, 'default.project.json'), path.join(second, 'default.project.json')]);
  });

  test('a forced refresh waits out an older rebuild, and concurrent forced calls share the next one', async () => {
    const root = fixture({ sourcemap: false });
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const resolver = new SourcemapResolver(() => root, {
      autoRefresh: false,
      env: {},
      runRojo: async () => {
        calls += 1;
        if (calls === 1) await gate;
        return JSON.stringify(SOURCEMAP);
      },
    });
    const older = resolver.refresh();
    const forced = [resolver.refresh(true), resolver.refresh(true)];
    release();
    expect((await older).stale).toBe('no sourcemap.json');
    const [a, b] = await Promise.all(forced);
    expect(a.stale).toBe('regenerate requested');
    expect(b.index).toBe(a.index);
    expect(calls).toBe(2);
  });

  test('a map rebuilt from a project with a future mtime stays fresh until the project changes again', async () => {
    const root = fixture({ sourcemap: false });
    const project = path.join(root, 'default.project.json');
    setMtime(project, 3600);
    const rojo = fakeRojo();
    const resolver = new SourcemapResolver(() => root, { runRojo: rojo.run, autoRefresh: false, env: {} });
    expect((await resolver.refresh()).rebuilt).toBe(true);
    expect((await resolver.refresh()).rebuilt).toBeUndefined();
    setMtime(project, 7200);
    expect((await resolver.refresh()).stale).toMatch(/default\.project\.json changed/);
    expect(rojo.calls).toHaveLength(2);
  });

  test('setting a project root starts its rebuild at once', async () => {
    const root = fixture({ sourcemap: false });
    const rojo = fakeRojo();
    const resolver = new SourcemapResolver(() => os.tmpdir(), { runRojo: rojo.run, env: {} });
    resolver.setProjectRoot(root);
    expect(rojo.calls).toEqual([path.join(root, 'default.project.json')]);
    expect((await resolver.refresh()).index?.generatedFrom).toBe(path.join(root, 'default.project.json'));
    expect(rojo.calls).toHaveLength(1);
  });

  test('player containers and their contents map to the starter containers they are copied from', () => {
    expect(starterPath(['Players', 'dx', 'PlayerScripts', 'Client'])).toEqual(['StarterPlayer', 'StarterPlayerScripts', 'Client']);
    expect(starterPath(['Players', 'dx', 'PlayerGui'])).toEqual(['StarterGui']);
    expect(starterPath(['Players', 'dx', 'Backpack', 'Sword', 'Swing'])).toEqual(['StarterPack', 'Sword', 'Swing']);
    expect(starterPath(['Players', 'dx'])).toBeUndefined();
    expect(starterPath(['Workspace', 'dx', 'PlayerGui'])).toBeUndefined();
    expect(starterPath(['Players', 'dx', 'constructor'])).toBeUndefined();
  });

  test('without a project or sourcemap there is nothing to rebuild', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-sync-empty-'));
    const resolver = new SourcemapResolver(() => root, { runRojo: fakeRojo().run, autoRefresh: false });
    expect((await resolver.refresh(true)).error).toMatch(/no sourcemap\.json or default\.project\.json/);
  });

  (hasRojo ? test : test.skip)('real rojo builds the map from stdout without writing into the project', async () => {
    const root = fixture({ sourcemap: false });
    const resolver = new SourcemapResolver(() => root, { autoRefresh: false });
    const result = await resolver.refresh();
    expect(result.error).toBeUndefined();
    expect(result.rebuilt).toBe(true);
    expect([...result.index!.byPath.keys()].sort()).toEqual([DAMAGE, MAIN, UTIL, INPUT].sort());
    expect(fs.existsSync(path.join(root, 'sourcemap.json'))).toBe(false);

    fs.writeFileSync(path.join(root, 'default.project.json'), '{ not json');
    const broken = await resolver.refresh(true);
    expect(broken.error).toBeTruthy();
    expect(broken.index?.byPath.size).toBe(4);
  });
});

type Live = Record<string, Record<string, string>>;

function argsOf(code: string): { role: string; paths: string[]; hashes: string[] } {
  const match = /JSONDecode\(\[(=*)\[\n([\s\S]*?)\]\1\]\)/.exec(code);
  return JSON.parse(match![2]);
}

// Plays the Luau snippet: live maps a peer id to the source of each script it holds.
function fakeStudio(peers: PeerTarget[], live: Live, failing: string[] = []) {
  const calls: Array<{ peerId: string; endpoint: string; role: string; paths: string[] }> = [];
  const host = {
    peerTargets: async (target: string | undefined) => (target === undefined || target === 'all' ? peers : peers.filter((peer) => peer.role === target)),
    requestPeer: async (endpoint: string, data: unknown, peerId: string) => {
      const args = argsOf((data as { code: string }).code);
      calls.push({ peerId, endpoint, role: args.role, paths: args.paths });
      if (failing.includes(peerId)) return { success: false, error: 'peer went away' };
      const result = { in_sync: 0, stale: [] as unknown[], missing: [] as string[], not_script: [], unreadable: [] };
      args.paths.forEach((scriptPath, i) => {
        const source = live[peerId][scriptPath];
        if (source === undefined) {
          result.missing.push(scriptPath);
          return;
        }
        const digest = sourceHash(Buffer.from(source));
        if (digest.hash === args.hashes[i]) result.in_sync += 1;
        else result.stale.push({ path: scriptPath, bytes: digest.bytes });
      });
      return { success: true, returnValue: JSON.stringify(result) };
    },
  };
  return { host, calls };
}

const PEERS: PeerTarget[] = [
  { role: 'edit', peerId: 'e' },
  { role: 'server', peerId: 's' },
  { role: 'client-1', peerId: 'c' },
];

const CURRENT = {
  [MAIN]: 'print("main v2")',
  [DAMAGE]: 'return 42',
  [INPUT]: 'print("input")',
  [UTIL]: 'return {}\n',
};
const OLD_MAIN = { ...CURRENT, [MAIN]: 'print("main v1")' };

function resolverFor(root: string) {
  return new SourcemapResolver(() => root, { runRojo: fakeRojo().run, autoRefresh: false, env: {} });
}

const body = (result: { content: Array<{ text?: string }> }) => JSON.parse(result.content[0].text!);

describe('verify_sync', () => {
  test('edit lagging disk while every running peer matches says the running code is current', async () => {
    const root = fixture();
    const { host, calls } = fakeStudio(PEERS, {
      e: { [MAIN]: OLD_MAIN[MAIN], [DAMAGE]: CURRENT[DAMAGE], [INPUT]: CURRENT[INPUT] },
      s: CURRENT,
      c: { [INPUT]: CURRENT[INPUT], [UTIL]: CURRENT[UTIL] },
    });
    const result = body(await verifySync(host, {}, undefined, resolverFor(root)));

    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.endpoint === '/api/execute-luau')).toBe(true);
    expect(calls.find((call) => call.peerId === 'c')).toMatchObject({ role: 'client', paths: [INPUT, UTIL].sort() });
    expect(calls.find((call) => call.peerId === 'e')!.role).toBe('edit');
    expect(result.all_in_sync).toBe(false);
    expect(result.checked).toBe(4);
    expect(result.sourcemap).toMatchObject({ origin: 'file', scripts: 5 });
    expect(result.missing_on_disk).toEqual([path.join('src', 'server', 'Removed.server.luau')]);
    expect(result.peers.edit).toEqual({
      in_sync: 2,
      stale: 1,
      missing_in_studio: 1,
      stale_scripts: [{ path: MAIN, file: path.join('src', 'server', 'Main.server.luau'), disk_bytes: 16, live_bytes: 16 }],
      missing_scripts: [UTIL],
    });
    expect(result.peers.server).toEqual({ in_sync: 4, stale: 0, missing_in_studio: 0 });
    expect(result.peers['client-1']).toEqual({ in_sync: 2, stale: 0, missing_in_studio: 0, skipped_server_only: 2 });
    expect(result.hint).toMatch(/Edit Source lags disk for 1 script but the running peers match disk/);
    expect(result.hint).toMatch(/1 script is in the sourcemap but missing in edit/);
    expect(result.hint).toMatch(/1 file\(s\) no longer on disk, so rerun with regenerate=true/);
    expect(calls.flatMap((call) => call.paths)).not.toContain(REMOVED);
  });

  test('stale in edit and at runtime means old code is running', async () => {
    const root = fixture();
    const { host } = fakeStudio(PEERS.slice(0, 2), { e: OLD_MAIN, s: OLD_MAIN });
    const result = body(await verifySync(host, {}, undefined, resolverFor(root)));
    expect(result.peers.server.stale).toBe(1);
    expect(result.hint).toMatch(/1 script differs from disk in edit and at runtime, so old code is running/);
  });

  test('stale only at runtime means the playtest predates the sync', async () => {
    const root = fixture();
    const { host } = fakeStudio(PEERS.slice(0, 2), { e: CURRENT, s: OLD_MAIN });
    const result = body(await verifySync(host, {}, undefined, resolverFor(root)));
    expect(result.peers.edit).toEqual({ in_sync: 4, stale: 0, missing_in_studio: 0 });
    expect(result.hint).toMatch(/at runtime while edit matches, so the playtest started before the change synced/);
  });

  test('edit stale with no playtest running points at both explanations', async () => {
    const root = fixture();
    const { host } = fakeStudio(PEERS.slice(0, 1), { e: OLD_MAIN });
    const result = body(await verifySync(host, {}, undefined, resolverFor(root)));
    expect(result.hint).toMatch(/check a running server or client to see what runs/);
  });

  test('a peer that hides script source is reported as unavailable, not stale', async () => {
    const root = fixture();
    const { host } = fakeStudio([PEERS[2]], { c: { [INPUT]: '', [UTIL]: '' } });
    const result = body(await verifySync(host, { peers: 'client-1' }, undefined, resolverFor(root)));
    expect(result.peers['client-1']).toMatchObject({ source_unavailable: true });
    expect(result.hint ?? '').not.toMatch(/differ from disk/);
  });

  test('paths narrow the check, unknown paths are listed, and limit caps the lists', async () => {
    const root = fixture();
    const { host, calls } = fakeStudio(PEERS, { e: {}, s: {}, c: {} }, ['s']);
    const result = body(await verifySync(host, {
      paths: ['ServerScriptService', 'game.ReplicatedStorage.Shared.Util', 'Workspace.Nothing'],
      peers: 'all',
      limit: 1,
    }, 'studio-1', resolverFor(root)));
    expect(result.checked).toBe(3);
    expect(result.unmatched_paths).toEqual(['Workspace.Nothing']);
    expect(result.peers.edit).toMatchObject({ missing_in_studio: 3, missing_scripts: [UTIL], truncated: true });
    expect(result.peers.server).toEqual({ error: 'peer went away' });
    expect(calls.find((call) => call.peerId === 'c')!.paths).toEqual([UTIL]);
  });

  test('rebuilds a stale map before checking and reports it', async () => {
    const root = fixture();
    setMtime(path.join(root, 'sourcemap.json'), -1000);
    setMtime(path.join(root, 'default.project.json'), -2000);
    const rojo = fakeRojo();
    const resolver = new SourcemapResolver(() => root, { runRojo: rojo.run, autoRefresh: false, env: {} });
    const { host } = fakeStudio(PEERS.slice(0, 1), { e: CURRENT });
    const result = body(await verifySync(host, { regenerate: false }, undefined, resolver));
    expect(rojo.calls).toHaveLength(1);
    expect(result.sourcemap).toMatchObject({ origin: 'rojo', rebuilt_because: 'the map is over 300s old' });
    expect(result.hint).toMatch(/no longer on disk\.$/);
  });

  test('without any sourcemap or project it explains how to point at one', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-sync-empty-'));
    const { host } = fakeStudio(PEERS, { e: {}, s: {}, c: {} });
    await expect(verifySync(host, {}, undefined, resolverFor(root))).rejects.toThrow(/project_root/);
  });

  test('a runtime copy path selects the starter script it was copied from', async () => {
    const root = fixture();
    const { host, calls } = fakeStudio([PEERS[2]], { c: { [INPUT]: CURRENT[INPUT] } });
    for (const paths of [['game.Players.Player1.PlayerScripts.Input'], ['Players.Player1.PlayerScripts']]) {
      const result = body(await verifySync(host, { paths, peers: 'client-1' }, undefined, resolverFor(root)));
      expect(result).toMatchObject({ all_in_sync: true, checked: 1 });
      expect(result.unmatched_paths).toBeUndefined();
    }
    expect(calls.map((call) => call.paths)).toEqual([[INPUT], [INPUT]]);
  });

  test('paths that match nothing are never reported as in sync', async () => {
    const root = fixture();
    const { host, calls } = fakeStudio(PEERS, { e: CURRENT, s: CURRENT, c: CURRENT });
    const result = body(await verifySync(host, { paths: ['Workspace.Nothing'] }, undefined, resolverFor(root)));
    expect(result).toMatchObject({ all_in_sync: false, checked: 0, unmatched_paths: ['Workspace.Nothing'], peers: {} });
    expect(result.hint).toMatch(/1 requested path\(s\) match no synced script/);
    expect(calls).toHaveLength(0);

    const partly = body(await verifySync(host, { paths: [UTIL, 'Workspace.Nothing'] }, undefined, resolverFor(root)));
    expect(partly).toMatchObject({ all_in_sync: false, checked: 1 });
    expect(partly.peers.server).toEqual({ in_sync: 1, stale: 0, missing_in_studio: 0 });
  });

  test('a library sourcemap checks nothing and says so', async () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, 'sourcemap.json'), JSON.stringify({ name: 'Lib', className: 'ModuleScript', filePaths: ['src/shared/Util.luau'] }));
    const { host } = fakeStudio(PEERS, { e: {}, s: {}, c: {} });
    const result = body(await verifySync(host, {}, undefined, resolverFor(root)));
    expect(result).toMatchObject({ all_in_sync: false, checked: 0, peers: {} });
    expect(result.hint).toMatch(/maps no scripts/);
  });

  test('one empty client copy of a non-empty file is unreadable, not stale, while the server stays strict', async () => {
    const root = fixture();
    const { host } = fakeStudio(PEERS.slice(1), {
      s: { ...CURRENT, [UTIL]: '' },
      c: { [INPUT]: CURRENT[INPUT], [UTIL]: '' },
    });
    const result = body(await verifySync(host, {}, undefined, resolverFor(root)));
    expect(result.peers['client-1']).toEqual({
      in_sync: 1,
      stale: 0,
      missing_in_studio: 0,
      skipped_server_only: 2,
      unreadable: [{ path: UTIL, error: 'Source reads empty on this client' }],
    });
    expect(result.peers.server).toMatchObject({ in_sync: 3, stale: 1 });
    expect(result.hint).toMatch(/^1 script differs from disk at runtime\. Restart/);
  });

  test('a script edit cannot see is not described as matching in edit', async () => {
    const root = fixture();
    const { host } = fakeStudio(PEERS.slice(0, 2), {
      e: { [DAMAGE]: CURRENT[DAMAGE], [INPUT]: CURRENT[INPUT], [UTIL]: CURRENT[UTIL] },
      s: OLD_MAIN,
    });
    const result = body(await verifySync(host, {}, undefined, resolverFor(root)));
    expect(result.hint).not.toMatch(/while edit matches/);
    expect(result.hint).toMatch(/1 script differs from disk at runtime and edit holds no readable copy to compare/);
    expect(result.hint).toMatch(/1 script is in the sourcemap but missing in edit/);
  });

  test('the handler routes through forkHost with instance_id', () => {
    expect(String(syncFeature.handlers.verify_sync)).toContain('body.instance_id');
    expect(syncFeature.definitions.map((definition) => definition.name)).toEqual(['verify_sync']);
    expect(syncFeature.guide?.startsWith('## ')).toBe(true);
  });
});

const NEW = 'return "new"';
const OLD = 'return "old"';

// Just enough of the Instance API for the real snippet to run under the luau CLI.
const LUAU_STUDIO = String.raw`
Enum = { RunContext = { Legacy = "Legacy", Server = "Server", Client = "Client", Plugin = "Plugin" } }
task = { wait = function() end }
local SCRIPTS = { Script = true, LocalScript = true, ModuleScript = true }
local methods = {}
function methods.FindFirstChild(self, name)
	for _, child in rawget(self, "_children") do
		if child.Name == name then return child end
	end
	return nil
end
function methods.FindFirstChildOfClass(self, className)
	for _, child in rawget(self, "_children") do
		if child.ClassName == className then return child end
	end
	return nil
end
function methods.IsA(self, className)
	return self.ClassName == className or (className == "LuaSourceContainer" and SCRIPTS[self.ClassName] == true)
end
function methods.GetDescendants(self)
	local out = {}
	local function walk(node)
		for _, child in rawget(node, "_children") do
			table.insert(out, child)
			walk(child)
		end
	end
	walk(self)
	return out
end
function methods.GetService(self, name)
	return methods.FindFirstChild(self, name) or error(name .. " is not a valid Service name")
end
local meta = {
	__index = function(self, key)
		if methods[key] then return methods[key] end
		if key == "Source" and rawget(self, "_locked") then error("The current thread cannot read 'Source' (lacking capability Plugin)") end
		return nil
	end,
}
local function node(name, className, props, children)
	local instance = setmetatable({ Name = name, ClassName = className, _children = children or {} }, meta)
	for key, value in props or {} do instance[key] = value end
	for _, child in instance._children do child.Parent = instance end
	return instance
end
local function encode(value)
	if type(value) == "string" then
		return '"' .. string.gsub(value, '[%c"\\]', function(char) return string.format("\\u%04x", string.byte(char)) end) .. '"'
	elseif type(value) ~= "table" then
		return tostring(value)
	end
	local parts = {}
	if next(value) == nil or #value > 0 then
		for _, item in value do table.insert(parts, encode(item)) end
		return "[" .. table.concat(parts, ",") .. "]"
	end
	for key, item in value do table.insert(parts, encode(key) .. ":" .. encode(item)) end
	return "{" .. table.concat(parts, ",") .. "}"
end
`;

function luauLiteral(value: unknown): string {
  if (typeof value === 'string') return luauString(Buffer.from(value));
  if (Array.isArray(value)) return `{ ${value.map(luauLiteral).join(', ')} }`;
  if (value && typeof value === 'object') {
    return `{ ${Object.entries(value).map(([key, item]) => `[${luauString(Buffer.from(key))}] = ${luauLiteral(item)}`).join(', ')} }`;
  }
  return String(value);
}

/** Runs a verify_sync snippet against world, Luau that sets the global game, and returns the table it produced. */
function runLuau(code: string, world: string): Record<string, unknown> {
  const json = /JSONDecode\(\[(=*)\[\n([\s\S]*?)\]\1\]\)/.exec(code)![2];
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fork-sync-run-')), 'run.luau');
  fs.writeFileSync(file, `${LUAU_STUDIO}
local NEW, OLD = ${luauString(Buffer.from(NEW))}, ${luauString(Buffer.from(OLD))}
local EXPECTED_JSON = ${luauString(Buffer.from(json))}
local ARGS_VALUE = ${luauLiteral(JSON.parse(json))}
local HTTP = node("HttpService", "HttpService", {
	JSONDecode = function(_, text)
		assert(text == EXPECTED_JSON, "ARGS changed in transit")
		return ARGS_VALUE
	end,
})
${world}
local function snippet()
${code}
end
print(encode(snippet()))
`);
  const result = spawnSync('luau', [file], { encoding: 'utf8' });
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout);
}

const CLIENT_WORLD = String.raw`
local player = node("Player1", "Player", {}, {
	node("PlayerScripts", "PlayerScripts", {}, {
		node("Input", "LocalScript", { Source = NEW }),
		node("Camera", "LocalScript", { Source = OLD }),
	}),
	node("PlayerGui", "PlayerGui", {}, { node("Hud", "ScreenGui", {}, { node("Button", "LocalScript", { Source = NEW }) }) }),
	node("Backpack", "Backpack", {}, { node("Sword", "Tool", {}, { node("Swing", "LocalScript", { Source = NEW }) }) }),
})
player.Character = node("Player1", "Model", {}, {
	node("Sprint", "LocalScript", { Source = NEW }),
	node("Health", "Script", { Source = "", RunContext = Enum.RunContext.Legacy }),
})
game = node("Game", "DataModel", {}, {
	HTTP,
	node("Players", "Players", { LocalPlayer = player }, { player }),
	node("StarterPlayer", "StarterPlayer", {}, {
		node("StarterPlayerScripts", "StarterPlayerScripts", {}, {
			node("Input", "LocalScript", { Source = OLD }),
			node("Camera", "LocalScript", { Source = NEW }),
			node("Fallback", "LocalScript", { Source = NEW }),
		}),
		node("StarterCharacterScripts", "StarterCharacterScripts", {}, {
			node("Sprint", "LocalScript", { Source = OLD }),
			node("Health", "Script", { Source = "", RunContext = Enum.RunContext.Legacy }),
		}),
	}),
	node("StarterGui", "StarterGui", {}, { node("Hud", "ScreenGui", {}, { node("Button", "LocalScript", { Source = OLD }) }) }),
	node("StarterPack", "StarterPack", {}, { node("Sword", "Tool", {}, { node("Swing", "LocalScript", { Source = OLD }) }) }),
	node("ReplicatedStorage", "ReplicatedStorage", {}, {
		node("Util", "ModuleScript", { Source = NEW }),
		node("runTests", "Script", { Source = "", RunContext = Enum.RunContext.Legacy }),
		node("ClientRun", "Script", { Source = NEW, RunContext = Enum.RunContext.Client }),
		node("Locked", "ModuleScript", { _locked = true }),
		node("Folder", "Folder"),
	}),
})
`;

const EDIT_WORLD = String.raw`
game = node("Game", "DataModel", {}, {
	HTTP,
	node("ScriptEditorService", "ScriptEditorService", {
		GetEditorSource = function(_, script)
			if rawget(script, "_editorFails") then error("script is not open") end
			return rawget(script, "_editor") or script.Source
		end,
	}),
	node("Players", "Players"),
	node("ServerScriptService", "ServerScriptService", {}, {
		node("Open", "Script", { Source = OLD, _editor = NEW, RunContext = Enum.RunContext.Legacy }),
		node("Closed", "Script", { Source = NEW, _editorFails = true, RunContext = Enum.RunContext.Legacy }),
		node("Stale", "ModuleScript", { Source = OLD }),
		node("Locked", "ModuleScript", { _locked = true }),
	}),
	node("StarterPlayer", "StarterPlayer", {}, {
		node("StarterPlayerScripts", "StarterPlayerScripts", {}, { node("Input", "LocalScript", { Source = NEW }) }),
	}),
	node("ReplicatedStorage", "ReplicatedStorage", {}, {
		node("runTests", "Script", { Source = NEW, RunContext = Enum.RunContext.Legacy }),
	}),
})
`;

const newHashes = (paths: string[]) => paths.map(() => sourceHash(Buffer.from(NEW)).hash);

(hasLuau ? describe : describe.skip)('verify_sync snippet under luau', () => {
  test('a script game code moved is found by name and source, but not one sitting at another synced path', () => {
    const world = String.raw`
game = node("Game", "DataModel", {}, {
	HTTP,
	node("Players", "Players"),
	node("ServerScriptService", "ServerScriptService", {}, {
		node("Server", "Folder", {}, { node("CmdrCommands", "Folder") }),
	}),
	node("ReplicatedStorage", "ReplicatedStorage", {}, {
		node("CmdrClient", "Folder", {}, {
			node("Commands", "Folder", {}, {
				node("Weather", "ModuleScript", { Source = NEW }),
				node("Yen", "ModuleScript", { Source = OLD }),
			}),
		}),
		node("Util", "ModuleScript", { Source = NEW }),
	}),
})
`;
    const paths = [
      'game.ServerScriptService.Server.CmdrCommands.Weather',
      'game.ServerScriptService.Server.CmdrCommands.Yen',
      'game.ServerScriptService.Server.Util',
      'game.ReplicatedStorage.Util',
    ];
    const result = runLuau(verifySyncLuau({ role: 'server', paths, hashes: newHashes(paths) }), world);
    expect(result).toEqual({
      in_sync: 1,
      stale: [],
      missing: ['game.ServerScriptService.Server.CmdrCommands.Yen', 'game.ServerScriptService.Server.Util'],
      moved: [{ path: 'game.ServerScriptService.Server.CmdrCommands.Weather', now: 'game.ReplicatedStorage.CmdrClient.Commands.Weather' }],
      not_script: [],
      unreadable: [],
      skipped: [],
    });
  });

  test('a client compares its running copies, skips server Scripts and falls back to the template', () => {
    const paths = [
      'game.StarterPlayer.StarterPlayerScripts.Input',
      'game.StarterPlayer.StarterPlayerScripts.Camera',
      'game.StarterPlayer.StarterPlayerScripts.Fallback',
      'game.StarterPlayer.StarterCharacterScripts.Sprint',
      'game.StarterPlayer.StarterCharacterScripts.Health',
      'game.StarterGui.Hud.Button',
      'game.StarterPack.Sword.Swing',
      'game.ReplicatedStorage.Util',
      'game.ReplicatedStorage.runTests',
      'game.ReplicatedStorage.ClientRun',
      'game.ReplicatedStorage.Locked',
      'game.ReplicatedStorage.Folder',
      'game.ReplicatedStorage.Gone',
    ];
    const result = runLuau(verifySyncLuau({ role: 'client', paths, hashes: newHashes(paths) }), CLIENT_WORLD);
    expect(result).toEqual({
      in_sync: 7,
      stale: [{ path: 'game.StarterPlayer.StarterPlayerScripts.Camera', bytes: OLD.length }],
      skipped: ['game.StarterPlayer.StarterCharacterScripts.Health', 'game.ReplicatedStorage.runTests'],
      unreadable: [{ path: 'game.ReplicatedStorage.Locked', error: expect.stringMatching(/cannot read 'Source'/) }],
      not_script: ['game.ReplicatedStorage.Folder'],
      missing: ['game.ReplicatedStorage.Gone'],
    });
  });

  test('edit reads open editor text, falls back to Source, and the server reads Source only', () => {
    const paths = [
      'game.ServerScriptService.Open',
      'game.ServerScriptService.Closed',
      'game.ServerScriptService.Stale',
      'game.ServerScriptService.Locked',
      'game.StarterPlayer.StarterPlayerScripts.Input',
      'game.ReplicatedStorage.runTests',
      'game.ServerScriptService.Gone',
    ];
    const edit = runLuau(verifySyncLuau({ role: 'edit', paths, hashes: newHashes(paths) }), EDIT_WORLD);
    expect(edit).toMatchObject({
      in_sync: 4,
      stale: [{ path: 'game.ServerScriptService.Stale', bytes: OLD.length }],
      unreadable: [{ path: 'game.ServerScriptService.Locked' }],
      missing: ['game.ServerScriptService.Gone'],
      skipped: [],
    });
    const server = runLuau(verifySyncLuau({ role: 'server', paths, hashes: newHashes(paths) }), EDIT_WORLD);
    expect(server).toMatchObject({
      in_sync: 3,
      stale: [{ path: 'game.ServerScriptService.Open' }, { path: 'game.ServerScriptService.Stale' }],
      skipped: [],
    });
  });

  test('verify_sync end to end: a PlayerScripts path checks the copy the client runs', async () => {
    const root = fixture();
    const world = String.raw`
local player = node("Player1", "Player", {}, {
	node("PlayerScripts", "PlayerScripts", {}, { node("Input", "LocalScript", { Source = 'print("input")' }) }),
})
game = node("Game", "DataModel", {}, {
	HTTP,
	node("Players", "Players", { LocalPlayer = player }, { player }),
	node("StarterPlayer", "StarterPlayer", {}, {
		node("StarterPlayerScripts", "StarterPlayerScripts", {}, { node("Input", "LocalScript", { Source = OLD }) }),
	}),
})
`;
    const host = {
      peerTargets: async () => [PEERS[2]],
      requestPeer: async (_endpoint: string, data: unknown) => ({ success: true, returnValue: JSON.stringify(runLuau((data as { code: string }).code, world)) }),
    };
    const result = body(await verifySync(host, { paths: ['Players.Player1.PlayerScripts.Input'], peers: 'client-1' }, undefined, resolverFor(root)));
    expect(result).toMatchObject({ all_in_sync: true, checked: 1, peers: { 'client-1': { in_sync: 1, stale: 0, missing_in_studio: 0 } } });
  });
});
