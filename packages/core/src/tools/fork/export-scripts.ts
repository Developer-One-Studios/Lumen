import * as fs from 'fs';
import * as path from 'path';
import { resolveArtifactWritePath, writeArtifact } from '../../artifact-paths.js';
import type { ToolDefinition } from '../definitions.js';
import { withArgs } from '../fork-luau.js';
import { luauValue, toolText, type ForkHost } from '../fork-tools.js';
import type { ForkFeature, ForkToolResult } from './feature.js';

const EXECUTE = '/api/execute-luau';
const EXPORT_TIMEOUT_S = 60;
// Sources travel in one reply, and the bridge caps a reply well above this.
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_LISTED = 50;
// Names a file system refuses, or that Rojo would read as something else.
const BAD_NAME = /[\\/:*?"<>|]|^\.|\.$|^\s|\s$|^init$/i;
const badName = (name: string) => BAD_NAME.test(name) || [...name].some((char) => char.charCodeAt(0) < 0x20);

type Node = { name: string; className: string; runContext?: string; source?: string; children: Node[] };

export function exportScriptsLuau(rootPath: string): string {
  return withArgs(String.raw`
local root = resolve(ARGS.root_path)
if root == nil then
	return { error = "export_scripts found nothing at " .. tostring(ARGS.root_path) }
end

local function node(instance)
	local out = { name = instance.Name, className = instance.ClassName, children = {} }
	if instance:IsA("LuaSourceContainer") then
		local ok, source = pcall(function() return (instance :: any).Source end)
		out.source = if ok then source else ""
		if instance:IsA("Script") and not instance:IsA("LocalScript") then
			local ok2, context = pcall(function() return instance.RunContext end)
			if ok2 then out.runContext = context.Name end
		end
	end
	for _, child in instance:GetChildren() do
		table.insert(out.children, node(child))
	end
	return out
end
return { root = pathOf(root), tree = node(root) }
`, { root_path: rootPath });
}

type Planned = { files: Array<{ file: string; source: string }>; skipped: Array<{ path: string; reason: string }> };

/**
 * Lays a tree out the way Rojo reads it back: Folders become directories, a script becomes a file named for its
 * kind, and a script with children becomes a directory holding init.<kind>.<extension> next to them.
 */
export function planScriptFiles(tree: Node, extension: string): Planned {
  const planned: Planned = { files: [], skipped: [] };
  const suffix = (node: Node) => {
    if (node.className === 'LocalScript' || (node.className === 'Script' && node.runContext === 'Client')) return '.client';
    if (node.className === 'Script') return '.server';
    return '';
  };
  const isScript = (node: Node) => node.source !== undefined;

  const visit = (node: Node, directory: string, studioPath: string, isRoot: boolean) => {
    if (!isScript(node) && node.className !== 'Folder') {
      planned.skipped.push({ path: studioPath, reason: `${node.className} has no Rojo file form, export it with export_rbxm` });
      return;
    }
    if (!isRoot && badName(node.name)) {
      planned.skipped.push({ path: studioPath, reason: 'its name cannot be a file name' });
      return;
    }
    const kept = node.children.filter((child) => {
      const clash = node.children.filter((other) => other.name.toLowerCase() === child.name.toLowerCase()).length > 1;
      if (clash) planned.skipped.push({ path: `${studioPath}.${child.name}`, reason: 'it shares its name with a sibling, so the files would collide' });
      return !clash;
    });
    if (isScript(node) && kept.length === 0) {
      planned.files.push({ file: isRoot ? `init${suffix(node)}.${extension}` : path.posix.join(directory, `${node.name}${suffix(node)}.${extension}`), source: node.source ?? '' });
      return;
    }
    const own = isRoot ? directory : path.posix.join(directory, node.name);
    if (isScript(node)) planned.files.push({ file: path.posix.join(own, `init${suffix(node)}.${extension}`), source: node.source ?? '' });
    for (const child of kept) visit(child, own, `${studioPath}.${child.name}`, false);
  };
  visit(tree, '', tree.name, true);
  return planned;
}

export async function exportScripts(host: ForkHost, body: Record<string, unknown>, instanceId: string | undefined): Promise<ForkToolResult> {
  const rootPath = body.instance_path;
  if (typeof rootPath !== 'string' || rootPath === '') throw new Error('instance_path is required');
  const extension = body.extension === undefined ? 'lua' : body.extension;
  if (extension !== 'lua' && extension !== 'luau') throw new Error('extension must be lua or luau');

  const peers = await host.peerTargets('edit', instanceId);
  if (peers.length !== 1) throw new Error(`export_scripts needs exactly one edit DataModel, ${peers.length} matched; pass instance_id`);
  const reply = luauValue(await host.requestPeer(EXECUTE, { code: exportScriptsLuau(rootPath), timeout_s: EXPORT_TIMEOUT_S }, peers[0].peerId, (EXPORT_TIMEOUT_S + 15) * 1000));
  const tree = reply.tree as Node | undefined;
  if (!tree || typeof tree !== 'object') throw new Error('Studio returned no tree');

  const planned = planScriptFiles(tree, extension);
  const bytes = planned.files.reduce((sum, entry) => sum + Buffer.byteLength(entry.source), 0);
  if (bytes > MAX_SOURCE_BYTES) throw new Error(`the scripts hold ${Math.ceil(bytes / 1048576)} MB, over the ${MAX_SOURCE_BYTES / 1048576} MB limit`);
  if (planned.files.length === 0) throw new Error(`no scripts under ${String(reply.root)} to export`);

  const outDir = typeof body.output_dir === 'string' && body.output_dir !== '' ? body.output_dir : `scripts/${tree.name}`;
  // An export into a folder that already exists would mix two exports, and stale files would look exported.
  const folder = resolveArtifactWritePath(outDir);
  if (fs.existsSync(folder)) throw new Error(`${folder} already exists, pass a new output_dir`);
  const written: string[] = [];
  for (const entry of planned.files) {
    writeArtifact(path.posix.join(outDir, entry.file), entry.source);
    written.push(entry.file);
  }
  return toolText({
    root: reply.root,
    folder,
    files: written.length,
    lines: planned.files.reduce((sum, entry) => sum + entry.source.split('\n').length, 0),
    bytes,
    written: written.slice(0, MAX_LISTED),
    ...(written.length > MAX_LISTED ? { more: written.length - MAX_LISTED } : {}),
    ...(planned.skipped.length > 0 ? { skipped: planned.skipped.slice(0, MAX_LISTED) } : {}),
  });
}

const EXPORT_DEFINITION: ToolDefinition = {
  name: 'export_scripts',
  category: 'write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  description: 'Use to write a script or Folder tree from Studio as Rojo source files, such as a library to sync into a project.',
  inputSchema: {
    type: 'object',
    properties: {
      instance_path: { type: 'string', description: 'Script or Folder whose tree is written.' },
      output_dir: { type: 'string', description: 'New folder in the artifact folder, defaults to scripts/<name>.' },
      extension: { type: 'string', enum: ['lua', 'luau'], default: 'lua', description: 'Source file extension.' },
      instance_id: { type: 'string', description: 'Studio process ID when ambiguous.' },
    },
    required: ['instance_path'],
  },
};

const GUIDE = `
## Exporting scripts as files

- export_scripts writes a script tree from the edit DataModel as files Rojo syncs back to the same tree: a Folder is a directory, a ModuleScript is Name.lua, a Script is Name.server.lua and a LocalScript (or a Client RunContext Script) is Name.client.lua.
- A script with children becomes a directory with init.lua (init.server.lua, init.client.lua) beside its children, and so does the exported root.
- Files go to output_dir inside the artifact folder, scripts/<root name> by default, and that folder must not exist yet, so two exports never mix.
- Instances that are neither scripts nor Folders, names a file system cannot hold and same-named siblings are listed under skipped instead of written.
- Copy the folder into the project afterwards, where Rojo picks it up.
`;

export const exportScriptsFeature: ForkFeature = {
  name: 'export-scripts',
  definitions: [EXPORT_DEFINITION],
  handlers: {
    export_scripts: (tools, body) => exportScripts(tools.forkHost, body, body.instance_id as string | undefined),
  },
  guide: GUIDE,
};
