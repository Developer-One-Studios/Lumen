import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { publicToolDefinition } from '../mcp-runtime.js';
import type { ForkHost, PeerTarget } from '../tools/fork-tools.js';
import { inspectRbxm, inspectRbxmFeature } from '../tools/fork/inspect-rbxm.js';
import { inspectRbxmLuau } from '../tools/fork/inspect-rbxm-luau.js';

type Call = { endpoint: string; data: Record<string, unknown>; peerId: string; timeoutMs?: number };

const ok = (value: unknown) => ({ success: true, returnValue: JSON.stringify(value) });
const body = (result: { content: Array<{ text?: string }> }) => JSON.parse(result.content[0].text!);

function args(code: string): Record<string, unknown> {
  const match = /JSONDecode\(\[(=*)\[\n([\s\S]*?)\]\1\]\)/.exec(code);
  return match ? JSON.parse(match[2]) : {};
}

function fakeHost(peers: PeerTarget[], reply: (call: Call) => unknown) {
  const calls: Call[] = [];
  const host: ForkHost = {
    peerTargets: async () => peers,
    requestPeer: async (endpoint, data, peerId, timeoutMs) => {
      const call = { endpoint, data: data as Record<string, unknown>, peerId, timeoutMs };
      calls.push(call);
      return reply(call);
    },
    soloPlaytest: async () => ({ content: [] }),
    getRuntimeLogs: async () => ({ content: [] }),
  };
  return { host, calls };
}

const EDIT = [{ role: 'edit', peerId: 'p-edit' }];
const FILE = Buffer.from('<roblox!fake model bytes').toString('base64');

describe('inspect_rbxm', () => {
  test('reads the source and sends it to the edit DataModel with clamped options', async () => {
    const { host, calls } = fakeHost(EDIT, () => ok({ roots: 1, nodes: [{ path: 'allstuff', class: 'Model' }] }));
    const result = body(await inspectRbxm(host, {
      source: { base64: FILE }, root: 'allstuff', depth: 99, limit: 0, assets: true, match_in: 'game.ReplicatedStorage.Units',
    }, undefined));
    expect(result).toEqual({ source: expect.stringMatching(/^base64\(/), bytes: 24, roots: 1, nodes: [{ path: 'allstuff', class: 'Model' }] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ endpoint: '/api/execute-luau', peerId: 'p-edit' });
    expect(args(calls[0].data.code as string)).toEqual({
      base64: FILE, root: 'allstuff', depth: 8, limit: 1, assets: true, match_in: 'game.ReplicatedStorage.Units',
    });
  });

  test('reads a path like import_rbxm does', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inspect-rbxm-'));
    const file = path.join(dir, 'delivery.rbxm');
    fs.writeFileSync(file, Buffer.from('rbxm'));
    const { host, calls } = fakeHost(EDIT, () => ok({ roots: 0, nodes: [] }));
    const result = body(await inspectRbxm(host, { source: { path: file } }, undefined));
    expect(result).toMatchObject({ source: file, bytes: 4 });
    expect(args(calls[0].data.code as string)).toMatchObject({ base64: Buffer.from('rbxm').toString('base64'), depth: 2, limit: 100, assets: false });
  });

  test('refuses a missing source or an unclear Studio before reading anything', async () => {
    const { host, calls } = fakeHost(EDIT, () => ok({}));
    await expect(inspectRbxm(host, {}, undefined)).rejects.toThrow(/source is required/);
    await expect(inspectRbxm(host, { source: { base64: FILE }, assets: 'yes' }, undefined)).rejects.toThrow(/assets must be a boolean/);
    const none = fakeHost([], () => ok({}));
    await expect(inspectRbxm(none.host, { source: { base64: FILE } }, undefined)).rejects.toThrow(/edit DataModel, 0 matched/);
    expect(calls).toHaveLength(0);
  });

  test('errors from the Luau surface as tool errors', async () => {
    const { host } = fakeHost(EDIT, () => ok({ error: 'root x is not in the file, whose top level holds: allstuff' }));
    await expect(inspectRbxm(host, { source: { base64: FILE }, root: 'x' }, undefined)).rejects.toThrow(/top level holds: allstuff/);
  });

  test('registers with routing, guide and catalog budget', () => {
    expect(inspectRbxmFeature.definitions.map((definition) => definition.name)).toEqual(['inspect_rbxm']);
    const [definition] = inspectRbxmFeature.definitions;
    expect(definition.category).toBe('write');
    expect(definition.annotations).toMatchObject({ readOnlyHint: true });
    expect(String(inspectRbxmFeature.handlers.inspect_rbxm)).toContain('body.instance_id');
    expect(JSON.stringify(publicToolDefinition(definition)).length).toBeLessThanOrEqual(1500);
    expect(inspectRbxmFeature.guide).toMatch(/^\s*## Inspecting an rbxm file/);
    expect(inspectRbxmFeature.guide).not.toMatch(/[—–;]/);
  });
});

const compiler = spawnSync('luau-compile', ['--help']).error ? undefined : 'luau-compile';
const interpreter = spawnSync('luau', ['--help']).error ? undefined : 'luau';

const SNIPPET = inspectRbxmLuau({ base64: FILE, root: 'allstuff', depth: 1, limit: 100, assets: true, match_in: 'game.ReplicatedStorage.Units' });

describe('inspect_rbxm Luau', () => {
  (compiler ? test : test.skip)('compiles as Luau', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fork-inspect-')), 'inspect.luau');
    fs.writeFileSync(file, SNIPPET);
    const result = spawnSync(compiler!, ['--null', file], { encoding: 'utf8' });
    expect(result.stderr + result.stdout).not.toMatch(/error/i);
    expect(result.status).toBe(0);
  });
});

// Just enough engine for the snippet: instances with children and attributes, three services and a file of roots.
const HARNESS = String.raw`
local Methods = {}
local Meta = { __index = function(self, key) return Methods[key] end }
local function new(class, name, parent, props)
	local instance = setmetatable({ ClassName = class, Name = name, Parent = parent, _children = {}, _attributes = {} }, Meta)
	for key, value in props or {} do rawset(instance, key, value) end
	if parent ~= nil then table.insert(parent._children, instance) end
	return instance
end
function Methods.GetChildren(self) return table.clone(self._children) end
function Methods.GetDescendants(self)
	local out = {}
	local function walk(node)
		for _, child in node._children do
			table.insert(out, child)
			walk(child)
		end
	end
	walk(self)
	return out
end
function Methods.FindFirstChild(self, name)
	for _, child in self._children do
		if child.Name == name then return child end
	end
	return nil
end
function Methods.GetAttributes(self) return self._attributes end
function Methods.Destroy(self) DESTROYED[self.Name] = true end

DESTROYED = {}
local game = new("DataModel", "Game")
local services = {}
for _, class in { "HttpService", "SerializationService", "EncodingService", "ReplicatedStorage" } do
	services[class] = new(class, class, game)
end
function Methods.GetService(_, class)
	local found = services[class]
	if found == nil then error(class .. " is not a valid Service name") end
	return found
end
function Methods.JSONDecode() return TEST_ARGS end
function Methods.Base64Decode(_, value) return value end
function Methods.DeserializeInstancesAsync() return FILE_ROOTS end
buffer = buffer or { fromstring = function(value) return value end }

-- The delivery: a container of two statues and one effect.
local allstuff = new("Model", "allstuff")
allstuff._attributes = { Version = 2 }
local juudara = new("Model", "Juudara", allstuff)
local body = new("Model", "Body", juudara)
new("MeshPart", "Leg", body, { MeshId = "rbxassetid://101", TextureID = "rbxassetid://102" })
new("MeshPart", "Arm", body, { MeshId = "rbxassetid://103", TextureID = "" })
local aura = new("Part", "Part", juudara)
new("ParticleEmitter", "Flames", aura, { Texture = "rbxassetid://900" })
local megumin = new("Model", "Megumin_fnl", allstuff)
new("MeshPart", "Hat", megumin, { MeshId = "http://www.roblox.com/asset/?id=201" })
local tp = new("Model", "Tp", allstuff)
new("ParticleEmitter", "Glow", tp, { Texture = "rbxassetid://900" })
FILE_ROOTS = { allstuff }

-- The place's unit models.
local units = new("Folder", "Units", services.ReplicatedStorage)
local madara = new("Model", "MadaraEvo", units)
new("MeshPart", "Leg", madara, { MeshId = "rbxassetid://101", TextureID = "rbxassetid://102" })
local madaraBase = new("Model", "Madara", units)
new("MeshPart", "Leg", madaraBase, { MeshId = "rbxassetid://101" })
local gojo = new("Model", "Gojo", units)
new("MeshPart", "Head", gojo, { MeshId = "rbxassetid://555" })

local function encode(value)
	local kind = type(value)
	if kind == "nil" then return "null" end
	if kind == "boolean" then return tostring(value) end
	if kind == "number" then return if value == math.floor(value) then string.format("%d", value) else tostring(value) end
	if kind == "string" then return '"' .. string.gsub(value, '[%c"\\]', function(c) return string.format("\\u%04x", string.byte(c)) end) .. '"' end
	if getmetatable(value) == Meta then return '"<' .. value.Name .. '>"' end
	if next(value) == nil then return "[]" end
	local parts = {}
	if value[1] ~= nil then
		for _, item in value do table.insert(parts, encode(item)) end
		return "[" .. table.concat(parts, ",") .. "]"
	end
	for key, item in value do table.insert(parts, encode(tostring(key)) .. ":" .. encode(item)) end
	return "{" .. table.concat(parts, ",") .. "}"
end
`;

function luauLiteral(value: unknown): string {
  if (Array.isArray(value)) return `{${value.map((item) => luauLiteral(item)).join(', ')}}`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).map(([key, item]) => `[${JSON.stringify(key)}] = ${luauLiteral(item)}`).join(', ')}}`;
  }
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function runInspect(options: Parameters<typeof inspectRbxmLuau>[0]): { result: Record<string, any>; destroyed: Record<string, boolean> } {
  const code = inspectRbxmLuau(options);
  const lines = [
    HARNESS,
    `TEST_ARGS = ${luauLiteral(args(code))}`,
    `local RESULT = (function()\n${code}\nend)()`,
    'print(encode({ result = RESULT, destroyed = DESTROYED }))',
  ];
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fork-inspect-run-')), 'run.luau');
  fs.writeFileSync(file, lines.join('\n'));
  const run = spawnSync(interpreter!, [file], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`luau failed: ${run.stderr}${run.stdout}`);
  const output = run.stdout.trim().split('\n');
  return JSON.parse(output[output.length - 1]);
}

(interpreter ? describe : describe.skip)('inspect_rbxm Luau on a mock engine', () => {
  test('lists the tree to depth, sums up deeper levels and frees the copies', () => {
    const { result, destroyed } = runInspect({ base64: FILE, depth: 1, limit: 100, assets: false });
    expect(result.roots).toBe(1);
    expect(result.nodes).toEqual([
      { path: 'allstuff', class: 'Model', children: 3, attributes: { Version: 2 } },
      { path: 'allstuff/Juudara', class: 'Model', children: 2, inside: 'MeshPart=2, Model=1, Part=1, ParticleEmitter=1' },
      { path: 'allstuff/Megumin_fnl', class: 'Model', children: 1, inside: 'MeshPart=1' },
      { path: 'allstuff/Tp', class: 'Model', children: 1, inside: 'ParticleEmitter=1' },
    ]);
    expect(destroyed).toEqual({ allstuff: true });
  });

  test('starts at root, stops at limit and lists asset ids by property', () => {
    const { result } = runInspect({ base64: FILE, root: 'allstuff/Juudara', depth: 3, limit: 3, assets: true });
    expect(result.nodes.map((node: { path: string }) => node.path)).toEqual(['allstuff/Juudara', 'allstuff/Juudara/Body', 'allstuff/Juudara/Body/Leg']);
    expect(result.truncated).toBe(true);
    expect(result.assets).toEqual({
      MeshId: { distinct: 2, ids: [['101', 1], ['103', 1]] },
      TextureID: { distinct: 1, ids: [['102', 1]] },
      Texture: { distinct: 1, ids: [['900', 1]] },
    });
  });

  test('matches each item of a container by meshes and their textures, never by effect textures', () => {
    const { result } = runInspect({ base64: FILE, depth: 0, limit: 10, assets: false, match_in: 'game.ReplicatedStorage.Units' });
    expect(result.matches).toEqual([
      {
        item: 'allstuff/Juudara',
        ids: 3,
        best: [
          { path: 'game.ReplicatedStorage.Units.MadaraEvo', shared: 2, ids: 2 },
          { path: 'game.ReplicatedStorage.Units.Madara', shared: 1, ids: 1 },
        ],
      },
      { item: 'allstuff/Megumin_fnl', ids: 1, best: [] },
      { item: 'allstuff/Tp', ids: 0, best: [] },
    ]);
  });

  test('a root that is not in the file names what is', () => {
    const { result, destroyed } = runInspect({ base64: FILE, root: 'stuff/Juudara', depth: 1, limit: 10, assets: false });
    expect(result.error).toBe('root stuff/Juudara is not in the file, whose top level holds: allstuff');
    expect(destroyed).toEqual({ allstuff: true });
  });
});
