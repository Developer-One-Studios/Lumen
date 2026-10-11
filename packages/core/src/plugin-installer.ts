import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  getPluginsFolder,
  installPluginAsset,
} from './install-plugin-helpers.js';
import type { PluginVariant } from './install-plugin-helpers.js';

export interface PluginInstallOptions {
  sourcePath?: string;
  replaceVariant?: boolean;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

// Lumen ships privately, so the plugin always comes from the package or the checkout that built it.
// Downloading a release would install whatever a public repository happens to publish under that tag.
/** Resolve artifacts and versions relative to the calling edition, including bundled CLIs. */
export function createPluginInstaller(moduleUrl: string, variant: PluginVariant) {
  const currentDir = dirname(fileURLToPath(moduleUrl));
  const ASSET_NAME = variant === 'main' ? 'LumenPlugin.rbxmx' : 'LumenInspectorPlugin.rbxmx';
  const OTHER_VARIANT = variant === 'main' ? 'LumenInspectorPlugin.rbxmx' : 'LumenPlugin.rbxmx';
  const buildCommand = variant === 'main' ? 'build:plugin' : 'build:plugin:inspector';

  function bundledAssetPath(): string | null {
    const candidates = [
      join(currentDir, '..', 'studio-plugin', ASSET_NAME),
      join(currentDir, '..', '..', '..', 'studio-plugin', ASSET_NAME),
    ];
    return candidates.find((candidate) => existsSync(candidate)) ?? null;
  }

  function resolvePluginAssetPath(sourcePath: string | undefined): string | null {
    if (sourcePath === undefined) return bundledAssetPath();
    return existsSync(sourcePath) ? sourcePath : null;
  }

  function packageVersion(): string {
    const pkg = JSON.parse(readFileSync(join(currentDir, '..', 'package.json'), 'utf8')) as { version?: string };
    if (!pkg.version) {
      throw new Error('Package version not found');
    }
    return pkg.version;
  }

  function installSource(source: Buffer, options: PluginInstallOptions) {
    return installPluginAsset({
      pluginsFolder: getPluginsFolder(),
      assetName: ASSET_NAME,
      otherAssetName: OTHER_VARIANT,
      source,
      expectedVersion: packageVersion(),
      expectedVariant: variant,
      replaceVariant: options.replaceVariant ?? true,
      log: options.log ?? console.log,
      warn: options.warn ?? console.warn,
    });
  }

  function requireAsset(options: PluginInstallOptions): string {
    const sourcePath = resolvePluginAssetPath(options.sourcePath);
    if (sourcePath) return sourcePath;
    if (options.sourcePath !== undefined) throw new Error(`Plugin asset not found at explicit path ${options.sourcePath}.`);
    throw new Error(`Bundled ${ASSET_NAME} not found. Run npm run ${buildCommand} in this worktree first.`);
  }

  async function installBundledPlugin(options: PluginInstallOptions = {}): Promise<void> {
    const log = options.log ?? console.log;
    const result = installSource(readFileSync(requireAsset(options)), options);
    if (result.installed) {
      log(`Installed ${ASSET_NAME} to ${result.destination}`);
    }
  }

  async function installPlugin(options: PluginInstallOptions = {}): Promise<void> {
    const log = options.log ?? console.log;
    const result = installSource(readFileSync(requireAsset(options)), options);
    log(result.installed ? `Installed bundled ${ASSET_NAME} to ${result.destination}` : `${ASSET_NAME} already installed.`);
  }

  return { installBundledPlugin, installPlugin };
}
