import { createPluginInstaller } from 'lumen-mcp-core';
import type { PluginInstallOptions } from 'lumen-mcp-core';

const installer = createPluginInstaller(import.meta.url, 'inspector');

export async function installBundledPlugin(options: PluginInstallOptions = {}): Promise<void> {
  await installer.installBundledPlugin(options);
}

export async function installPlugin(options: PluginInstallOptions = {}): Promise<void> {
  await installer.installPlugin(options);
}
