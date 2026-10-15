import * as fs from 'fs';

/**
 * Fills ROBLOX_OPEN_CLOUD_API_KEY from the file that ROBLOX_OPEN_CLOUD_API_KEY_FILE names, unless the key is already set.
 * A file keeps the key out of process listings, shell history and MCP client configs. Every tool reads the variable,
 * so loading it once at startup covers them all. Returns a problem worth reporting, never the key itself.
 */
export function loadOpenCloudKeyFile(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const file = env.ROBLOX_OPEN_CLOUD_API_KEY_FILE?.trim();
  if (!file || env.ROBLOX_OPEN_CLOUD_API_KEY?.trim()) return undefined;
  let key: string;
  try {
    key = fs.readFileSync(file, 'utf8').trim();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unreadable';
    return `ROBLOX_OPEN_CLOUD_API_KEY_FILE could not be read (${code}): ${file}`;
  }
  if (!key) return `ROBLOX_OPEN_CLOUD_API_KEY_FILE is empty: ${file}`;
  env.ROBLOX_OPEN_CLOUD_API_KEY = key;
  return undefined;
}
