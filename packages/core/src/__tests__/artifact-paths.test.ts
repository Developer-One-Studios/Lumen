import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveArtifactReadPath, writeArtifact } from '../artifact-paths.js';

function sandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-'));
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  return { root, outside, env: { ROBLOX_MCP_ARTIFACT_DIR: root } as NodeJS.ProcessEnv };
}

describe('artifact path confinement', () => {
  test('relative paths land inside the root, nested folders included', () => {
    const { root, env } = sandbox();
    const written = writeArtifact('profiles/run1/summary.json', '{}', env);
    expect(written).toBe(path.join(root, 'profiles/run1/summary.json'));
    expect(fs.readFileSync(written, 'utf8')).toBe('{}');
    expect(resolveArtifactReadPath('profiles/run1/summary.json', env)).toBe(fs.realpathSync(written));
  });

  test('traversal and absolute paths outside the root are refused before anything is created', () => {
    const { root, outside, env } = sandbox();
    expect(() => writeArtifact('../outside/x.json', '{}', env)).toThrow(/outside ROBLOX_MCP_ARTIFACT_DIR/);
    expect(() => writeArtifact(path.join(outside, 'x.json'), '{}', env)).toThrow(/outside ROBLOX_MCP_ARTIFACT_DIR/);
    expect(() => writeArtifact(root, '{}', env)).toThrow(/outside ROBLOX_MCP_ARTIFACT_DIR/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  test('a symlinked folder inside the root cannot redirect the write or create folders outside', () => {
    const { root, outside, env } = sandbox();
    fs.symlinkSync(outside, path.join(root, 'link'));
    expect(() => writeArtifact('link/deep/x.json', '{}', env)).toThrow(/not a plain directory/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  test('a planted symlink at the final name is refused, dangling or not', () => {
    const { root, outside, env } = sandbox();
    fs.symlinkSync(path.join(outside, 'autostart.desktop'), path.join(root, 'dangling.json'));
    fs.writeFileSync(path.join(outside, 'existing'), 'keep');
    fs.symlinkSync(path.join(outside, 'existing'), path.join(root, 'live.json'));
    expect(() => writeArtifact('dangling.json', 'x', env)).toThrow(/symlink/);
    expect(() => writeArtifact('live.json', 'x', env)).toThrow(/symlink/);
    expect(fs.existsSync(path.join(outside, 'autostart.desktop'))).toBe(false);
    expect(fs.readFileSync(path.join(outside, 'existing'), 'utf8')).toBe('keep');
  });

  test('an existing artifact is replaced whole, and a folder at the final name is refused', () => {
    const { root, env } = sandbox();
    writeArtifact('report.json', 'a much longer first version', env);
    writeArtifact('report.json', 'short', env);
    expect(fs.readFileSync(path.join(root, 'report.json'), 'utf8')).toBe('short');
    fs.mkdirSync(path.join(root, 'folder.json'));
    expect(() => writeArtifact('folder.json', 'x', env)).toThrow(/not a plain file/);
  });

  test('reads through a symlink out of the root are refused', () => {
    const { root, outside, env } = sandbox();
    fs.writeFileSync(path.join(outside, 'secret.json'), '{}');
    fs.symlinkSync(path.join(outside, 'secret.json'), path.join(root, 'baseline.json'));
    expect(() => resolveArtifactReadPath('baseline.json', env)).toThrow(/outside ROBLOX_MCP_ARTIFACT_DIR/);
  });

  test('without a root the path is used as given', () => {
    const { outside } = sandbox();
    const target = path.join(outside, 'free', 'x.json');
    expect(writeArtifact(target, 'x', {})).toBe(target);
    expect(fs.readFileSync(target, 'utf8')).toBe('x');
  });
});
