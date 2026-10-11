import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// Studio on native Linux runs inside a Wine prefix, usually one Vinegar manages.
// Its Plugins folder lives under the prefix's Windows profile, not ~/Documents.
export function wineStudioPrefixes(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const dataHome = env.XDG_DATA_HOME || join(home, '.local', 'share');
  return [
    ...(env.WINEPREFIX ? [env.WINEPREFIX] : []),
    join(dataHome, 'vinegar', 'prefixes', 'studio'),
    join(home, '.var', 'app', 'org.vinegarhq.Vinegar', 'data', 'vinegar', 'prefixes', 'studio'),
  ];
}

export function findWineStudioPluginsFolder(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  exists: (path: string) => boolean = existsSync,
  listDir: (path: string) => string[] = (path) => readdirSync(path),
): string | undefined {
  for (const prefix of wineStudioPrefixes(env, home)) {
    const usersDir = join(prefix, 'drive_c', 'users');
    if (!exists(usersDir)) continue;
    let users: string[];
    try {
      users = listDir(usersDir).filter((name) => name !== 'Public');
    } catch {
      continue;
    }
    // Wine names the profile after the Unix user, try that one first.
    const preferred = env.USER ? [env.USER, ...users.filter((name) => name !== env.USER)] : users;
    for (const user of preferred) {
      const roblox = join(usersDir, user, 'AppData', 'Local', 'Roblox');
      if (exists(roblox)) return join(roblox, 'Plugins');
    }
  }
  return undefined;
}
