import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { missingInputHint } from '../artifact-paths.js';
import { loadOpenCloudKeyFile } from '../opencloud-key.js';

function keyFile(contents: string): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'opencloud-key-')), 'key');
  fs.writeFileSync(file, contents);
  return file;
}

describe('Open Cloud key file', () => {
  test('fills the key from the file, without its trailing newline', () => {
    const env: NodeJS.ProcessEnv = { ROBLOX_OPEN_CLOUD_API_KEY_FILE: keyFile('secret-key\n') };
    expect(loadOpenCloudKeyFile(env)).toBeUndefined();
    expect(env.ROBLOX_OPEN_CLOUD_API_KEY).toBe('secret-key');
  });

  test('an explicit key wins over the file', () => {
    const env: NodeJS.ProcessEnv = { ROBLOX_OPEN_CLOUD_API_KEY: 'direct', ROBLOX_OPEN_CLOUD_API_KEY_FILE: keyFile('from-file') };
    expect(loadOpenCloudKeyFile(env)).toBeUndefined();
    expect(env.ROBLOX_OPEN_CLOUD_API_KEY).toBe('direct');
  });

  test('a missing file is reported without setting a key', () => {
    const env: NodeJS.ProcessEnv = { ROBLOX_OPEN_CLOUD_API_KEY_FILE: path.join(os.tmpdir(), 'no-such-lumen-key') };
    expect(loadOpenCloudKeyFile(env)).toContain('could not be read (ENOENT)');
    expect(env.ROBLOX_OPEN_CLOUD_API_KEY).toBeUndefined();
  });

  test('an empty file is reported and never echoes any contents', () => {
    const env: NodeJS.ProcessEnv = { ROBLOX_OPEN_CLOUD_API_KEY_FILE: keyFile('  \n') };
    expect(loadOpenCloudKeyFile(env)).toContain('is empty');
    expect(env.ROBLOX_OPEN_CLOUD_API_KEY).toBeUndefined();
  });

  test('nothing happens without the setting', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(loadOpenCloudKeyFile(env)).toBeUndefined();
    expect(env).toEqual({});
  });
});

describe('missing input hint', () => {
  test('points at the artifact folder when one is configured', () => {
    expect(missingInputHint({ ROBLOX_MCP_ARTIFACT_DIR: '/srv/artifacts' })).toContain(path.resolve('/srv/artifacts'));
  });

  test('mentions the sandbox when no artifact folder is set', () => {
    expect(missingInputHint({})).toContain('sandboxed');
  });
});
