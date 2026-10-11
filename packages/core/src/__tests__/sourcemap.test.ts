import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  SourcemapResolver,
  buildSourcemapIndex,
  canonicalPath,
  formatInstancePath,
  parseInstancePath,
  projectRelative,
} from '../sourcemap.js';
import { assertNotSynced, assertSubtreeNotSynced } from '../tools/fork-tools.js';

const SOURCEMAP = {
  name: 'Infernus',
  className: 'DataModel',
  children: [
    {
      name: 'ServerScriptService',
      className: 'ServerScriptService',
      children: [
        {
          name: 'Combat',
          className: 'Folder',
          children: [{ name: 'Damage', className: 'ModuleScript', filePaths: ['src/server/Combat/Damage.luau'] }],
        },
        { name: 'Main', className: 'Script', filePaths: ['src/server/Main.server.luau', 'src/server/Main.meta.json'] },
      ],
    },
    {
      name: 'StarterPlayer',
      className: 'StarterPlayer',
      children: [{
        name: 'StarterPlayerScripts',
        className: 'StarterPlayerScripts',
        children: [{ name: 'Client', className: 'LocalScript', filePaths: ['src/client/init.client.luau'] }],
      }],
    },
    {
      name: 'ReplicatedStorage',
      className: 'ReplicatedStorage',
      children: [{ name: 'my module', className: 'ModuleScript', filePaths: ['src/shared/my module.luau'] }],
    },
  ],
};

function projectWithSourcemap(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcemap-'));
  fs.writeFileSync(path.join(root, 'sourcemap.json'), JSON.stringify(SOURCEMAP));
  fs.mkdirSync(path.join(root, 'src', 'server'), { recursive: true });
  return root;
}

describe('canonical instance paths', () => {
  test.each([
    ['game.Workspace.Part', ['Workspace', 'Part']],
    ['Workspace.Part', ['Workspace', 'Part']],
    ['game.ReplicatedStorage["my module"]', ['ReplicatedStorage', 'my module']],
    ['game["Workspace"]["a.b"].c', ['Workspace', 'a.b', 'c']],
    ['game.ServerScriptService..dir.ReproScript', ['ServerScriptService', '.dir', 'ReproScript']],
    ['game', []],
  ])('%s parses like the plugin', (input, parts) => {
    expect(parseInstancePath(input)).toEqual(parts);
  });

  test('formats keywords and odd names with brackets and round-trips', () => {
    const path = formatInstancePath(['Workspace', 'end', 'has "quote"', 'ok_1']);
    expect(path).toBe('game.Workspace["end"]["has \\"quote\\""].ok_1');
    expect(parseInstancePath(path)).toEqual(['Workspace', 'end', 'has "quote"', 'ok_1']);
    expect(canonicalPath('ServerScriptService.Main')).toBe('game.ServerScriptService.Main');
  });
});

describe('Rojo sourcemap resolution', () => {
  test('indexes script files of a place project and ignores non-script file paths', () => {
    const index = buildSourcemapIndex(SOURCEMAP, '/proj/sourcemap.json');
    expect(index.byPath.get('game.ServerScriptService.Main')).toBe('/proj/src/server/Main.server.luau');
    expect(index.byPath.get('game.ReplicatedStorage["my module"]')).toBe('/proj/src/shared/my module.luau');
    expect(index.byFile.get('/proj/src/server/Combat/Damage.luau')).toBe('game.ServerScriptService.Combat.Damage');
    expect(index.byPath.has('game.ServerScriptService.Combat')).toBe(false);
  });

  test('a library project without a DataModel root maps nothing', () => {
    const index = buildSourcemapIndex({ name: 'Lib', className: 'ModuleScript', filePaths: ['src/init.luau'] }, '/lib/sourcemap.json');
    expect(index.byPath.size).toBe(0);
  });

  test('maps runtime clones back to their starter containers and files back to paths', () => {
    const root = projectWithSourcemap();
    const resolver = new SourcemapResolver(() => path.join(root, 'src', 'server'));
    expect(resolver.fileForPath('Players.dx.PlayerScripts.Client')).toBe(path.join(root, 'src/client/init.client.luau'));
    expect(resolver.fileForPath('game.ServerScriptService.Combat.Damage')).toBe(path.join(root, 'src/server/Combat/Damage.luau'));
    expect(resolver.fileForPath('game.Workspace.Map.Part')).toBeUndefined();
    expect(resolver.pathForFile('src/server/Main.server.luau')).toBe('game.ServerScriptService.Main');
  });

  test('annotates errors and tracebacks with file and line, once', () => {
    const root = projectWithSourcemap();
    const resolver = new SourcemapResolver(() => root);
    const message = 'ServerScriptService.Combat.Damage:42: attempt to index nil\nScript \'ServerScriptService.Main\', Line 7';
    const annotated = resolver.annotateText(message);
    expect(annotated).toBe(
      'ServerScriptService.Combat.Damage:42 [src/server/Combat/Damage.luau:42]: attempt to index nil\n'
      + 'Script \'ServerScriptService.Main\', Line 7 [src/server/Main.server.luau:7]',
    );
    expect(resolver.annotateText(annotated)).toBe(annotated);
    expect(resolver.annotateValue({ entries: [{ message: 'Workspace.Thing:3: nope' }] })).toEqual({ entries: [{ message: 'Workspace.Thing:3: nope' }] });
  });

  test('reloads after the sourcemap changes on disk', () => {
    const root = projectWithSourcemap();
    const resolver = new SourcemapResolver(() => root);
    expect(resolver.fileForPath('game.ServerScriptService.New')).toBeUndefined();
    const updated = structuredClone(SOURCEMAP);
    updated.children[0].children!.push({ name: 'New', className: 'Script', filePaths: ['src/server/New.server.luau'] } as never);
    const file = path.join(root, 'sourcemap.json');
    fs.writeFileSync(file, JSON.stringify(updated));
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(file, later, later);
    expect(resolver.fileForPath('game.ServerScriptService.New')).toBe(path.join(root, 'src/server/New.server.luau'));
  });

  test('script edits on synced scripts are refused with the file to edit instead', async () => {
    const root = projectWithSourcemap();
    const resolver = new SourcemapResolver(() => root);
    await expect(assertNotSynced('game.ServerScriptService.Main', resolver)).rejects.toThrow(/src\/server\/Main\.server\.luau/);
    await expect(assertNotSynced('game.ServerScriptService.Unsynced', resolver)).resolves.toBeUndefined();
    await expect(assertNotSynced('Players.dx.PlayerScripts.Client', resolver)).resolves.toBeUndefined();
    await expect(assertSubtreeNotSynced('game.ServerScriptService', false, resolver)).rejects.toThrow(/2 script\(s\)/);
    await expect(assertSubtreeNotSynced(undefined, false, resolver)).rejects.toThrow(/synced by Rojo/);
    await expect(assertSubtreeNotSynced('game.ServerScriptService', true, resolver)).resolves.toBeUndefined();
    await expect(assertSubtreeNotSynced('game.Workspace', false, resolver)).resolves.toBeUndefined();
    process.env.ROBLOX_ALLOW_SYNCED_EDITS = '1';
    try {
      await expect(assertNotSynced('game.ServerScriptService.Main', resolver)).resolves.toBeUndefined();
    } finally {
      delete process.env.ROBLOX_ALLOW_SYNCED_EDITS;
    }
  });

  test('an edit made before the first rojo build finishes waits for it and is still refused', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcemap-'));
    fs.writeFileSync(path.join(root, 'default.project.json'), '{"name":"Infernus","tree":{"$className":"DataModel"}}');
    let finish!: () => void;
    const runRojo = () => new Promise<string>((fulfil) => { finish = () => fulfil(JSON.stringify(SOURCEMAP)); });
    const resolver = new SourcemapResolver(() => root, { runRojo, env: {} });
    // Both expectations attach before either settles, so one failing cannot leave the other rejection unhandled and crash jest.
    const refused = expect(assertNotSynced('game.ServerScriptService.Main', resolver)).rejects.toThrow(/src\/server\/Main\.server\.luau/);
    const subtree = expect(assertSubtreeNotSynced('game.ServerScriptService', false, resolver)).rejects.toThrow(/2 script\(s\)/);
    await new Promise((resolve) => setImmediate(resolve));
    finish();
    await Promise.all([refused, subtree]);
  });

  test('project files are shown relative to the project with forward slashes, other files in full', () => {
    const root = path.join(os.tmpdir(), 'game');
    expect(projectRelative(root, path.join(root, 'src', 'server', 'Main.server.luau'))).toBe('src/server/Main.server.luau');
    const outside = path.join(os.tmpdir(), 'elsewhere', 'Util.luau');
    expect(projectRelative(root, outside)).toBe(outside);
  });
});
