import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  cameraRestoreLuau,
  cameraSetLuau,
  fuzzRemoteLuau,
  guiCenterLuau,
  inspectGuiLuau,
  lagAuditLuau,
  leakSnapshotLuau,
  listRemotesLuau,
  luauLongString,
  multiEditLuau,
  navigateLuau,
  perfStatsLuau,
  profileToggleLuau,
  replicationProbeLuau,
  withArgs,
} from '../tools/fork-luau.js';

const SNIPPETS: Record<string, string> = {
  perfStats: perfStatsLuau({ duration_ms: 1000, sample_ms: 100, remotes: true, top_remotes: 5 }),
  lagAudit: lagAuditLuau({ root: 'game.Workspace', top: 10 }),
  profileToggle: profileToggleLuau({ category: 'particles', duration_ms: 1000 }),
  leakSnapshot: leakSnapshotLuau(),
  replication: replicationProbeLuau({ path: 'game.Workspace.Part', properties: ['Position'], children: true }),
  fuzz: fuzzRemoteLuau({ path: 'game.ReplicatedStorage.Remote', spam: 10, include_functions: false }),
  listRemotes: listRemotesLuau({ root: 'game.ReplicatedStorage', include_functions: true }),
  inspectGui: inspectGuiLuau({ at: { x: 10, y: 20 }, max_nodes: 10, visible_only: true, text: 'Play' }),
  guiCenter: guiCenterLuau({ path: 'PlayerGui.Main.Play' }),
  navigate: navigateLuau({ path: 'game.Workspace.Goal', speed_multiplier: 2, timeout_s: 5 }),
  navigatePoint: navigateLuau({ position: { x: 1, y: 2, z: 3 }, speed_multiplier: 1, timeout_s: 5 }),
  multiEdit: multiEditLuau({ path: 'game.ServerScriptService.A', parent_path: 'game.ServerScriptService', name: 'A', class_name: 'Script', edits: [{ old_string: '', new_string: 'print(1)' }] }),
  cameraSet: cameraSetLuau({ position: [0, 10, 0], look_at: [0, 0, 0] }),
  cameraRestore: cameraRestoreLuau({ saved: { cframe: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], focus: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] } }),
};

const compiler = spawnSync('luau-compile', ['--help']).error ? undefined : 'luau-compile';

describe('fork Luau snippets', () => {
  test('long strings survive any closing bracket level and a leading newline', () => {
    const tricky = '\n]]==]=]]';
    const literal = luauLongString(tricky);
    const level = /^\[(=*)\[/.exec(literal)![1];
    expect(literal.startsWith(`[${level}[\n`)).toBe(true);
    expect(literal.endsWith(`]${level}]`)).toBe(true);
    expect(tricky.includes(`]${level}]`)).toBe(false);
  });

  test.each(['a]', 'a]=', ']]=]=', ']'])('long string closes only at its end for %j', (tail) => {
    const literal = luauLongString(tail);
    const level = /^\[(=*)\[/.exec(literal)![1];
    const closer = `]${level}]`;
    expect(literal.indexOf(closer)).toBe(literal.length - closer.length);
  });

  test('arguments are passed as JSON, never spliced into code', () => {
    const code = withArgs('return ARGS', { path: 'game.Workspace["a]]b"]', n: 1 });
    expect(code).toContain('JSONDecode([=[\n{"path":"game.Workspace[\\"a]]b\\"]","n":1}]=])');
  });

  (compiler ? test.each(Object.entries(SNIPPETS)) : test.skip.each(Object.entries(SNIPPETS)))('%s compiles as Luau', (name, code) => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fork-luau-')), `${name}.luau`);
    fs.writeFileSync(file, code);
    const result = spawnSync(compiler!, ['--null', file], { encoding: 'utf8' });
    expect(result.stderr + result.stdout).not.toMatch(/error/i);
    expect(result.status).toBe(0);
  });
});
