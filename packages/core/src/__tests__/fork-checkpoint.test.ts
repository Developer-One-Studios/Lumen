import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { publicToolDefinition } from '../mcp-runtime.js';
import { SourcemapResolver } from '../sourcemap.js';
import { luauLongString } from '../tools/fork-luau.js';
import type { ForkHost, PeerTarget } from '../tools/fork-tools.js';
import {
  checkpointChangesLuau,
  checkpointCreateLuau,
  checkpointDropLuau,
  checkpointListLuau,
  checkpointRevertLuau,
} from '../tools/fork/checkpoint-luau.js';
import { DEFAULT_CHECKPOINT_ROOTS, checkpointFeature, runCheckpoint, type CheckpointRecord } from '../tools/fork/checkpoint.js';

type Call = { endpoint: string; code: string; peerId: string; timeoutMs?: number };

const ok = (value: unknown) => ({ success: true, returnValue: JSON.stringify(value) });
const body = (result: { content: Array<{ text?: string }> }) => JSON.parse(result.content[0].text!);

function args(code: string): Record<string, unknown> {
  const match = /JSONDecode\(\[(=*)\[\n([\s\S]*?)\]\1\]\)/.exec(code);
  return match ? JSON.parse(match[2]) : {};
}

function kind(code: string): string {
  if (code.includes('local function findRoot(')) return 'create';
  if (code.includes('local found = scan(checkpoint, ARGS.max_items)')) return 'changes';
  if (code.includes('local found = scan(checkpoint, 0)')) return 'revert';
  if (code.includes('return { checkpoints = list }')) return 'list';
  if (code.includes('STORE[ARGS.id] = nil')) return 'drop';
  return 'unknown';
}

function fakeHost(peers: PeerTarget[], reply: (call: Call) => unknown) {
  const calls: Call[] = [];
  const targets: Array<{ target?: string; instanceId?: string }> = [];
  const host: ForkHost = {
    peerTargets: async (target, instanceId) => {
      targets.push({ target, instanceId });
      return peers;
    },
    requestPeer: async (endpoint, data, peerId, timeoutMs) => {
      const call = { endpoint, code: (data as { code: string }).code, peerId, timeoutMs };
      calls.push(call);
      return reply(call);
    },
    soloPlaytest: async () => ({ content: [] }),
    getRuntimeLogs: async () => ({ content: [] }),
  };
  return { host, calls, targets };
}

const EDIT = [{ role: 'edit', peerId: 'e1' }];

function sourcemapDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-checkpoint-'));
  fs.writeFileSync(path.join(dir, 'sourcemap.json'), JSON.stringify({
    name: 'Game',
    className: 'DataModel',
    children: [
      {
        name: 'ReplicatedStorage',
        className: 'ReplicatedStorage',
        children: [{ name: 'Shared', className: 'Folder', children: [{ name: 'Util', className: 'ModuleScript', filePaths: ['src/shared/Util.luau'] }] }],
      },
      { name: 'Workspace', className: 'Workspace', children: [{ name: 'Odd Name', className: 'Script', filePaths: ['src/odd.server.luau'] }] },
    ],
  }));
  return dir;
}

describe('checkpoint tool', () => {
  test('create runs on the edit peer with default roots and is remembered for list', async () => {
    const known = new Map<string, CheckpointRecord>();
    const { host, calls, targets } = fakeHost(EDIT, (call) => {
      if (kind(call.code) === 'create') return ok({ id: 'cp1', roots: ['game.Workspace'], instances: 12, subtrees: 3, terrain: 'captured' });
      return ok({ checkpoints: [{ id: 'cp1' }] });
    });
    const created = body(await runCheckpoint(host, { action: 'create', include_terrain: true }, 'studio-a', { known }));
    expect(created.id).toBe('cp1');
    expect(targets[0]).toEqual({ target: 'edit', instanceId: 'studio-a' });
    expect(calls[0].peerId).toBe('e1');
    expect(calls[0].timeoutMs).toBeGreaterThanOrEqual(300_000);
    expect(args(calls[0].code)).toEqual({
      roots: DEFAULT_CHECKPOINT_ROOTS,
      explicit_roots: false,
      include_terrain: true,
      max_instances: 200_000,
    });
    expect([...known.values()]).toEqual([expect.objectContaining({ id: 'cp1', instance_id: 'studio-a', instances: 12, subtrees: 3, terrain: true })]);

    await runCheckpoint(host, { action: 'create', id: 'before-fix', roots: ['game.Workspace.Map'], max_instances: 5e9 }, 'studio-a', { known });
    expect(args(calls[1].code)).toMatchObject({ id: 'before-fix', roots: ['game.Workspace.Map'], explicit_roots: true, max_instances: 1_000_000 });
  });

  test('refuses playtest peers and bad arguments before running anything', async () => {
    const { host, calls } = fakeHost([{ role: 'server', peerId: 's1' }], () => ok({}));
    await expect(runCheckpoint(host, { action: 'list' }, 'group-server', {})).rejects.toThrow(/edit DataModel, not server/);
    await expect(runCheckpoint(host, { action: 'undo' }, undefined, {})).rejects.toThrow(/action must be one of/);
    await expect(runCheckpoint(host, { action: 'drop' }, undefined, {})).rejects.toThrow(/drop needs id/);
    await expect(runCheckpoint(host, { action: 'create', id: '' }, undefined, {})).rejects.toThrow(/id must be/);
    const edit = fakeHost(EDIT, () => ok({}));
    await expect(runCheckpoint(edit.host, { action: 'create', roots: [] }, undefined, {})).rejects.toThrow(/roots must be/);
    await expect(runCheckpoint(edit.host, { action: 'revert', paths: [''] }, undefined, {})).rejects.toThrow(/paths must be/);
    expect(calls).toHaveLength(0);
    expect(edit.calls).toHaveLength(0);
  });

  test('changes and revert send the scripts Rojo syncs, unless synced edits are allowed', async () => {
    const dir = sourcemapDir();
    const resolver = new SourcemapResolver(() => dir);
    const { host, calls } = fakeHost(EDIT, () => ok({ id: 'cp1' }));
    await runCheckpoint(host, { action: 'changes', id: 'cp1', max_items: 9999 }, undefined, { resolver });
    expect(args(calls[0].code)).toEqual({
      id: 'cp1',
      max_items: 500,
      synced: [['ReplicatedStorage', 'Shared', 'Util'], ['Workspace', 'Odd Name']],
    });
    await runCheckpoint(host, { action: 'revert', id: 'cp1', paths: ['game.Workspace.Map'] }, undefined, { resolver });
    expect(args(calls[1].code)).toMatchObject({ id: 'cp1', paths: ['game.Workspace.Map'], synced: expect.arrayContaining([['Workspace', 'Odd Name']]) });

    const previous = process.env.ROBLOX_ALLOW_SYNCED_EDITS;
    process.env.ROBLOX_ALLOW_SYNCED_EDITS = '1';
    try {
      await runCheckpoint(host, { action: 'revert' }, undefined, { resolver });
      expect(args(calls[2].code)).toEqual({ synced: [] });
    } finally {
      if (previous === undefined) delete process.env.ROBLOX_ALLOW_SYNCED_EDITS;
      else process.env.ROBLOX_ALLOW_SYNCED_EDITS = previous;
    }
  });

  test('revert paths are canonicalised from any form other tools accept, and broken ones are refused', async () => {
    const resolver = new SourcemapResolver(() => sourcemapDir());
    const { host, calls } = fakeHost(EDIT, () => ok({ id: 'cp1' }));
    await runCheckpoint(host, {
      action: 'revert',
      paths: ['Workspace.Map', "game.Workspace['Odd Name']", 'game.ReplicatedStorage["Shared"].Util'],
    }, undefined, { resolver });
    expect(args(calls[0].code).paths).toEqual(['game.Workspace.Map', 'game.Workspace["Odd Name"]', 'game.ReplicatedStorage.Shared.Util']);
    await expect(runCheckpoint(host, { action: 'revert', paths: ['game.Workspace["Broken'] }, undefined, { resolver }))
      .rejects.toThrow(/cannot parse game.Workspace\["Broken/);
    expect(calls).toHaveLength(1);
  });

  test('a snapshot lost to a plugin reload is reported as gone once, then as unknown', async () => {
    const known = new Map<string, CheckpointRecord>();
    let studio: string[] = [];
    const { host } = fakeHost(EDIT, (call) => {
      const kindOf = kind(call.code);
      if (kindOf === 'create') {
        studio.push('cp1');
        return ok({ id: 'cp1', roots: ['game.Workspace'], instances: 1, subtrees: 1 });
      }
      return ok({ missing: true, id: args(call.code).id, existing: studio });
    });
    await runCheckpoint(host, { action: 'create' }, undefined, { known });
    studio = [];
    await expect(runCheckpoint(host, { action: 'revert', id: 'cp1' }, undefined, { known }))
      .rejects.toThrow(/cp1 \(created .*\) is gone from Studio.*plugin reloaded or Studio restarted/);
    await expect(runCheckpoint(host, { action: 'changes', id: 'cp1' }, undefined, { known }))
      .rejects.toThrow('No checkpoint cp1 in this Studio, existing: none.');
    await expect(runCheckpoint(host, { action: 'changes' }, undefined, { known }))
      .rejects.toThrow(/No checkpoint exists in this Studio yet/);
  });

  test('list flags checkpoints this server made that Studio no longer holds, per Studio', async () => {
    const known = new Map<string, CheckpointRecord>([
      [JSON.stringify([null, 'cp1']), { id: 'cp1', created_at: 't1', roots: [], instances: 1, subtrees: 1, terrain: false }],
      [JSON.stringify([null, 'cp2']), { id: 'cp2', created_at: 't2', roots: [], instances: 1, subtrees: 1, terrain: false }],
      [JSON.stringify(['other', 'cp9']), { id: 'cp9', instance_id: 'other', created_at: 't9', roots: [], instances: 1, subtrees: 1, terrain: false }],
    ]);
    const { host } = fakeHost(EDIT, () => ok({ checkpoints: [{ id: 'cp2', instances: 1 }] }));
    const listed = body(await runCheckpoint(host, { action: 'list' }, undefined, { known }));
    expect(listed.checkpoints).toEqual([{ id: 'cp2', instances: 1 }]);
    expect(listed.lost).toEqual([{ id: 'cp1', created_at: 't1' }]);
    expect([...known.values()].map((record) => record.id).sort()).toEqual(['cp2', 'cp9']);
    expect(body(await runCheckpoint(host, { action: 'list' }, undefined, { known })).lost).toBeUndefined();
  });

  test('drop frees the snapshot and forgets it, even when Studio already lost it', async () => {
    const known = new Map<string, CheckpointRecord>([
      [JSON.stringify([null, 'cp1']), { id: 'cp1', created_at: 't1', roots: [], instances: 1, subtrees: 1, terrain: false }],
      [JSON.stringify([null, 'cp2']), { id: 'cp2', created_at: 't2', roots: [], instances: 1, subtrees: 1, terrain: false }],
    ]);
    const { host } = fakeHost(EDIT, (call) => (args(call.code).id === 'cp1'
      ? ok({ id: 'cp1', dropped: true })
      : ok({ missing: true, id: args(call.code).id, existing: [] })));
    expect(body(await runCheckpoint(host, { action: 'drop', id: 'cp1' }, undefined, { known }))).toEqual({ id: 'cp1', dropped: true });
    expect(body(await runCheckpoint(host, { action: 'drop', id: 'cp2' }, undefined, { known }))).toMatchObject({ id: 'cp2', dropped: false });
    expect(known.size).toBe(0);
    await expect(runCheckpoint(host, { action: 'drop', id: 'cp3' }, undefined, { known })).rejects.toThrow('No checkpoint cp3');
  });

  test('the feature handler routes by body.instance_id and advertises one tool', () => {
    expect(checkpointFeature.definitions.map((definition) => definition.name)).toEqual(['checkpoint']);
    expect(String(checkpointFeature.handlers.checkpoint)).toContain('body.instance_id');
    expect(checkpointFeature.guide).toMatch(/^\s*## Checkpoints/);
    expect(checkpointFeature.guide).not.toMatch(/[—–;]/);
    // Each feature tool gets about 1400 characters of the shared catalog budget.
    expect(JSON.stringify(publicToolDefinition(checkpointFeature.definitions[0])).length).toBeLessThanOrEqual(1400);
  });
});

const SNIPPETS: Record<string, string> = {
  create: checkpointCreateLuau({ id: 'cp1', roots: DEFAULT_CHECKPOINT_ROOTS, explicit_roots: false, include_terrain: true, max_instances: 200_000 }),
  changes: checkpointChangesLuau({ id: 'cp1', synced: [['ReplicatedStorage', 'Shared', 'Util']], max_items: 50 }),
  revert: checkpointRevertLuau({ id: 'cp1', paths: ['game.Workspace.Map'], synced: [] }),
  list: checkpointListLuau(),
  drop: checkpointDropLuau({ id: 'cp1' }),
};

const compiler = spawnSync('luau-compile', ['--help']).error ? undefined : 'luau-compile';
const interpreter = spawnSync('luau', ['--help']).error ? undefined : 'luau';

describe('checkpoint Luau', () => {
  (compiler ? test.each(Object.entries(SNIPPETS)) : test.skip.each(Object.entries(SNIPPETS)))('%s compiles as Luau', (name, code) => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fork-checkpoint-')), `${name}.luau`);
    fs.writeFileSync(file, code);
    const result = spawnSync(compiler!, ['--null', file], { encoding: 'utf8' });
    expect(result.stderr + result.stdout).not.toMatch(/error/i);
    expect(result.status).toBe(0);
  });
});

// A small stand-in for the Roblox DataModel, enough to run the real snippets under the luau CLI.
const HARNESS = String.raw`
local realTypeof = typeof
local STATE = {}
local ARGS_BY_JSON = {}
local RESULTS = {}
local LOG = {}
local W = {}
local FLAGS = {}
-- The CLI sandbox makes the real _G read only.
local _G = {}

local CLASS_PROPS = {
	Workspace = { Gravity = true, CurrentCamera = true },
	Lighting = { Brightness = true, ClockTime = true },
	Terrain = { MaxExtents = true },
	Camera = { CFrame = true },
	Model = { PrimaryPart = true },
	Part = { CFrame = true, Size = true, Position = true, Anchored = true },
	Script = { Enabled = true, Source = true },
	ModuleScript = { Source = true },
	StringValue = { Value = true },
	ObjectValue = { Value = true },
	WeldConstraint = { Part0 = true, Part1 = true, Enabled = true },
}
local SUPERCLASS = { Script = "LuaSourceContainer", ModuleScript = "LuaSourceContainer", Part = "BasePart" }
local Methods = {}
local MT = {}
local services = {}

-- ChangeHistoryService stand-in: an open recording logs undo steps that Cancel replays and Commit keeps for undo().
-- Like Studio, edits made outside a recording are folded into the next one, and an empty Commit adds no step.
local RECORDING = nil
local PENDING = {}
local REPLAYING = false
local HISTORY = {}

local function typeof(value)
	if STATE[value] then return "Instance" end
	return realTypeof(value)
end
local task = { wait = function() end }
local Enum = { FinishRecordingOperation = { Commit = "Commit", Cancel = "Cancel" } }

local function new(class, name, parent, props)
	local self = setmetatable({}, MT)
	STATE[self] = { class = class, name = name or class, children = {}, props = props or {}, attrs = {}, tags = {}, archivable = true }
	if parent then self.Parent = parent end
	return self
end

MT.__index = function(self, key)
	local s = STATE[self]
	if Methods[key] then return Methods[key] end
	if key == "Name" then return s.name end
	if key == "ClassName" then return s.class end
	if key == "Parent" then return s.parent end
	if key == "Archivable" then return s.archivable end
	local allowed = CLASS_PROPS[s.class]
	if allowed and allowed[key] then return s.props[key] end
	error(key .. " is not a valid member of " .. s.class)
end

MT.__newindex = function(self, key, value)
	local s = STATE[self]
	local before
	if key == "Parent" then
		if s.destroyed then error("The Parent property of " .. s.name .. " is locked") end
		if value ~= nil and FLAGS.failParent == s.name and not REPLAYING then error("mock parent failure") end
		before = s.parent
	elseif key == "Name" then
		before = s.name
	elseif key == "Archivable" then
		before = s.archivable
	else
		local allowed = CLASS_PROPS[s.class]
		if not (allowed and allowed[key]) then error(key .. " is not a valid member of " .. s.class) end
		before = s.props[key]
	end
	if not REPLAYING then table.insert(RECORDING or PENDING, { self, key, before }) end
	if key == "Parent" then
		if s.parent then
			local siblings = STATE[s.parent].children
			for index, child in siblings do
				if child == self then
					table.remove(siblings, index)
					break
				end
			end
		end
		s.parent = value
		if value then table.insert(STATE[value].children, self) end
	elseif key == "Name" then
		s.name = value
	elseif key == "Archivable" then
		s.archivable = value
	else
		s.props[key] = value
	end
end

local function replay(steps)
	REPLAYING = true
	for i = #steps, 1, -1 do
		local step = steps[i]
		step[1][step[2]] = step[3]
	end
	REPLAYING = false
end

-- Ctrl+Z on the last committed recording.
local function undo()
	replay(table.remove(HISTORY))
end

function Methods.GetChildren(self) return table.clone(STATE[self].children) end
function Methods.GetDescendants(self)
	local out = {}
	local function walk(node)
		for _, child in STATE[node].children do
			table.insert(out, child)
			walk(child)
		end
	end
	walk(self)
	return out
end
function Methods.IsDescendantOf(self, other)
	local current = STATE[self].parent
	while current do
		if current == other then return true end
		current = STATE[current].parent
	end
	return false
end
function Methods.IsA(self, class) return STATE[self].class == class or SUPERCLASS[STATE[self].class] == class end
function Methods.FindFirstChild(self, name)
	for _, child in STATE[self].children do
		if STATE[child].name == name then return child end
	end
	return nil
end
function Methods.FindFirstChildOfClass(self, class)
	for _, child in STATE[self].children do
		if STATE[child].class == class then return child end
	end
	return nil
end
function Methods.GetAttributes(self) return table.clone(STATE[self].attrs) end
function Methods.SetAttribute(self, key, value) STATE[self].attrs[key] = value end
function Methods.GetTags(self)
	local out = {}
	for tag in STATE[self].tags do table.insert(out, tag) end
	return out
end
function Methods.AddTag(self, tag) STATE[self].tags[tag] = true end
function Methods.Destroy(self)
	for _, child in Methods.GetChildren(self) do Methods.Destroy(child) end
	self.Parent = nil
	STATE[self].destroyed = true
end
-- Like the engine, references into the copied subtree move to the copies and all others are kept.
function Methods.Clone(self)
	if not STATE[self].archivable then return nil end
	local copies = {}
	local function copy(node)
		local s = STATE[node]
		local result = new(s.class, s.name, nil, table.clone(s.props))
		STATE[result].attrs = table.clone(s.attrs)
		STATE[result].tags = table.clone(s.tags)
		copies[node] = result
		for _, child in s.children do
			if STATE[child].archivable then copy(child).Parent = result end
		end
		return result
	end
	local root = copy(self)
	for _, result in copies do
		local props = STATE[result].props
		for key, value in props do
			if copies[value] then props[key] = copies[value] end
		end
	end
	return root
end
function Methods.GetService(_, class)
	local found = services[class]
	if found == nil then error(class .. " is not a valid Service name") end
	return found
end
function Methods.FindService(_, class) return services[class] end
function Methods.JSONDecode(_, text)
	local decoded = ARGS_BY_JSON[text]
	assert(decoded ~= nil, "unexpected ARGS " .. text)
	return decoded
end
function Methods.IsRunning() return FLAGS.running == true end
function Methods.GetEditorSource(_, script) return script.Source end
function Methods.TryBeginRecording(_, name)
	if FLAGS.busy or RECORDING then
		table.insert(LOG, "busy")
		return nil
	end
	table.insert(LOG, "begin:" .. name)
	RECORDING = PENDING
	PENDING = {}
	return "recording"
end
function Methods.FinishRecording(_, _, operation)
	if RECORDING == nil then error("no recording in progress") end
	table.insert(LOG, "finish:" .. operation)
	local steps = RECORDING
	RECORDING = nil
	if operation == "Commit" then
		if #steps > 0 then table.insert(HISTORY, steps) end
	elseif FLAGS.cancelFails then
		error("mock cancel failure")
	else
		replay(steps)
	end
end
function Methods.CopyRegion(_, region)
	table.insert(LOG, "copy")
	return { copiedFrom = region.Min }
end
function Methods.PasteRegion(_, region, corner, emptyCells)
	table.insert(LOG, "paste:" .. region.copiedFrom .. ":" .. corner .. ":" .. tostring(emptyCells))
end

local game = new("DataModel", "Game")
local function service(class)
	local created = new(class, class, game)
	services[class] = created
	return created
end
for _, class in { "HttpService", "RunService", "ScriptEditorService", "ChangeHistoryService" } do service(class) end

local function encode(value)
	local kind = type(value)
	if kind == "nil" then return "null" end
	if kind == "boolean" then return tostring(value) end
	if kind == "number" then return if value == math.floor(value) then string.format("%d", value) else tostring(value) end
	if kind == "string" then
		local escaped = string.gsub(value, '[%c"\\]', function(c) return string.format("\\u%04x", string.byte(c)) end)
		return '"' .. escaped .. '"'
	end
	if STATE[value] then return '"<Instance ' .. STATE[value].name .. '>"' end
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

const WORLD = String.raw`
local Workspace = service("Workspace")
Workspace.Gravity = 196.2
new("Terrain", "Terrain", Workspace, { MaxExtents = { Min = "min" } })
W.Camera = new("Camera", "Camera", Workspace)
W.Camera.Archivable = false
Workspace.CurrentCamera = W.Camera
W.Map = new("Model", "Map", Workspace)
W.Floor = new("Part", "Floor", W.Map, { CFrame = "0,0,0", Size = "4,1,4" })
W.Wall = new("Part", "Wall", W.Map, { CFrame = "0,5,0", Size = "1,10,4" })
W.Baseplate = new("Part", "Baseplate", Workspace, { CFrame = "0,-1,0" })
W.Ghost = new("Folder", "Ghost", Workspace)
W.Ghost.Archivable = false
local ReplicatedStorage = service("ReplicatedStorage")
W.Shared = new("Folder", "Shared", ReplicatedStorage)
W.Util = new("ModuleScript", "Util", W.Shared, { Source = "return 1" })
W.Config = new("StringValue", "Config", ReplicatedStorage, { Value = "a" })
W.Config:SetAttribute("Mode", "easy")
W.Config:AddTag("Tuning")
local ServerScriptService = service("ServerScriptService")
W.Main = new("Script", "Main", ServerScriptService, { Source = "print(1)", Enabled = true })
local Lighting = service("Lighting")
Lighting.Brightness = 2
Lighting.ClockTime = 14
local function names(parent)
	local out = {}
	for _, child in parent:GetChildren() do table.insert(out, child.Name) end
	table.sort(out)
	return out
end
`;

type Step = { name: string; code: string } | { luau: string };

function luauLiteral(value: unknown): string {
  if (Array.isArray(value)) return `{${value.map((item) => luauLiteral(item)).join(', ')}}`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).map(([key, item]) => `[${JSON.stringify(key)}] = ${luauLiteral(item)}`).join(', ')}}`;
  }
  // A long string cannot end in "]", which paths such as Workspace["Map"] do.
  if (typeof value === 'string') return JSON.stringify(value).replace(/\\u([0-9a-fA-F]{4})/g, '\\u{$1}');
  return String(value);
}

function runWorld(steps: Step[]): { results: Record<string, any>; log: string[] } {
  const lines = [HARNESS, WORLD];
  for (const step of steps) {
    if ('luau' in step) {
      lines.push(step.luau);
      continue;
    }
    const json = /JSONDecode\(\[(=*)\[\n([\s\S]*?)\]\1\]\)/.exec(step.code)![2];
    lines.push(`ARGS_BY_JSON[ ${luauLongString(json)} ] = ${luauLiteral(JSON.parse(json))}`);
    lines.push(`RESULTS[${JSON.stringify(step.name)}] = (function()\n${step.code}\nend)()`);
  }
  lines.push('print(encode({ results = RESULTS, log = LOG }))');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fork-checkpoint-world-')), 'world.luau');
  fs.writeFileSync(file, lines.join('\n'));
  const result = spawnSync(interpreter!, [file], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`luau failed: ${result.stderr}${result.stdout}`);
  const output = result.stdout.trim().split('\n');
  return JSON.parse(output[output.length - 1]);
}

const SYNCED = [['ReplicatedStorage', 'Shared', 'Util']];
const create = (extra: Partial<Parameters<typeof checkpointCreateLuau>[0]> = {}) => checkpointCreateLuau({
  roots: DEFAULT_CHECKPOINT_ROOTS, explicit_roots: false, include_terrain: false, max_instances: 1000, ...extra,
});
const changes = (id?: string, maxItems = 50) => checkpointChangesLuau({ id, synced: SYNCED, max_items: maxItems });
const revert = (paths?: string[]) => checkpointRevertLuau({ id: 'cp1', paths, synced: SYNCED });
const paths = (list: Array<{ path: string }>) => list.map((entry) => entry.path);

(interpreter ? describe : describe.skip)('checkpoint Luau on a mock DataModel', () => {
  test('snapshots, diffs, partially and fully reverts, and reverts again from the pristine copy', () => {
    const { results, log } = runWorld([
      { name: 'create', code: create({ include_terrain: true }) },
      { name: 'clean', code: changes() },
      {
        luau: String.raw`
W.Floor.CFrame = "9,0,0"
W.Extra = new("Part", "Extra", W.Map)
W.Wall:Destroy()
W.Baseplate.Parent = nil
W.Junk = new("Folder", "Junk", Workspace)
new("Part", "Debris", W.Junk)
W.Config.Value = "b"
W.Util.Source = "return 2"
W.Main.Name = "Renamed"
W.Ghost:SetAttribute("Touched", true)
Lighting.ClockTime = 3
`,
      },
      { name: 'dirty', code: changes('cp1') },
      { name: 'revertMap', code: revert(['game.Workspace.Map']) },
      { name: 'afterMap', code: changes() },
      { luau: 'RESULTS.oldMapParent = if W.Map.Parent == nil then "nil" else "attached"' },
      { luau: 'Workspace:FindFirstChild("Map"):FindFirstChild("Floor").Parent = Workspace' },
      { name: 'revertAll', code: revert() },
      {
        luau: String.raw`
local map = Workspace:FindFirstChild("Map")
RESULTS.world = {
	workspace = names(Workspace),
	map = names(map),
	floor = map:FindFirstChild("Floor").CFrame,
	scripts = names(ServerScriptService),
	config = ReplicatedStorage:FindFirstChild("Config").Value,
	configAttribute = ReplicatedStorage:FindFirstChild("Config"):GetAttributes().Mode,
	configTags = ReplicatedStorage:FindFirstChild("Config"):GetTags(),
	util = W.Util.Source,
	clockTime = Lighting.ClockTime,
}
map:FindFirstChild("Floor").CFrame = "7,7,7"
`,
      },
      { name: 'afterAll', code: changes() },
      { name: 'revertFloor', code: revert(['game.Workspace.Map.Floor']) },
      { luau: 'RESULTS.floorAgain = Workspace:FindFirstChild("Map"):FindFirstChild("Floor").CFrame' },
      { name: 'list', code: checkpointListLuau() },
      { name: 'drop', code: checkpointDropLuau({ id: 'cp1' }) },
      { name: 'gone', code: changes('cp1') },
    ]);

    expect(results.create).toMatchObject({
      id: 'cp1',
      roots: ['game.Workspace', 'game.ReplicatedStorage', 'game.ServerScriptService', 'game.Lighting'],
      subtrees: 6,
      instances: 9,
      unsnapshotted: ['game.Workspace.Ghost'],
      nonArchivable: 0,
      services: 2,
      terrain: 'captured',
    });
    expect(results.create.missingRoots).toContain('game.StarterPlayer.StarterPlayerScripts');
    expect(results.clean).toMatchObject({ clean: true, counts: { added: 0, removed: 0, modified: 0 } });

    const dirty = results.dirty;
    expect(dirty.counts).toEqual({ added: 3, removed: 2, modified: 5 });
    expect(dirty.added).toEqual([
      { path: 'game.Workspace.Map.Extra', class: 'Part' },
      { path: 'game.Workspace.Junk', class: 'Folder' },
    ]);
    expect(dirty.removed).toEqual(expect.arrayContaining([
      { path: 'game.Workspace.Map.Wall', class: 'Part' },
      { path: 'game.Workspace.Baseplate', class: 'Part' },
    ]));
    expect(dirty.modified).toEqual(expect.arrayContaining([
      { path: 'game.Workspace.Map.Floor', class: 'Part', fields: ['CFrame'] },
      { path: 'game.Workspace.Ghost', class: 'Folder', fields: ['Attributes'] },
      { path: 'game.ReplicatedStorage.Shared.Util', class: 'ModuleScript', fields: ['Source'] },
      { path: 'game.ReplicatedStorage.Config', class: 'StringValue', fields: ['Value'] },
      { path: 'game.ServerScriptService.Renamed', class: 'Script', fields: ['Name'] },
    ]));
    expect(dirty.services).toEqual([{ service: 'game.Lighting', property: 'ClockTime', before: 14, after: 3 }]);
    expect(dirty.subtrees).toEqual([
      { path: 'game.ReplicatedStorage.Config', change: 'changed' },
      { path: 'game.ReplicatedStorage.Shared', change: 'changed', skip: 'contains scripts synced by Rojo, for example game.ReplicatedStorage.Shared.Util' },
      { path: 'game.ServerScriptService.Main', change: 'changed' },
      { path: 'game.Workspace.Baseplate', change: 'changed' },
      { path: 'game.Workspace.Ghost', change: 'changed', skip: 'was not Archivable at checkpoint time, so no copy exists' },
      { path: 'game.Workspace.Map', change: 'changed' },
      { path: 'game.Workspace.Junk', change: 'added' },
    ]);
    expect(dirty.terrain).toBe('captured, not compared');

    expect(results.revertMap).toMatchObject({
      counts: { replaced: 1, removed: 0, skipped: 0, relinked: 0, dangling: 0 },
      replaced: ['game.Workspace.Map'],
      removed: [],
      skipped: [],
      unmatchedPaths: [],
    });
    expect(results.revertMap.terrain).toBeUndefined();
    expect(results.afterMap.counts).toEqual({ added: 2, removed: 1, modified: 4 });
    expect(paths(results.afterMap.subtrees)).not.toContain('game.Workspace.Map');
    expect(results.oldMapParent).toBe('nil');

    expect(results.revertAll).toMatchObject({
      counts: { replaced: 4, removed: 2, skipped: 2, relinked: 0, dangling: 0 },
      replaced: ['game.ReplicatedStorage.Config', 'game.ServerScriptService.Main', 'game.Workspace.Baseplate', 'game.Workspace.Map'],
      removed: ['game.Workspace.Junk', 'game.Workspace.Floor'],
      restoredProperties: ['game.Lighting.ClockTime'],
      terrain: 'restored',
    });
    expect(paths(results.revertAll.skipped)).toEqual(['game.ReplicatedStorage.Shared', 'game.Workspace.Ghost']);
    expect(results.world).toEqual({
      workspace: ['Baseplate', 'Camera', 'Ghost', 'Map', 'Terrain'],
      map: ['Floor', 'Wall'],
      floor: '0,0,0',
      scripts: ['Main'],
      config: 'a',
      configAttribute: 'easy',
      configTags: ['Tuning'],
      util: 'return 2',
      clockTime: 14,
    });
    expect(results.afterAll.counts).toEqual({ added: 0, removed: 0, modified: 3 });
    expect(paths(results.afterAll.subtrees)).toEqual(['game.ReplicatedStorage.Shared', 'game.Workspace.Ghost', 'game.Workspace.Map']);
    expect(results.revertFloor.replaced).toEqual(['game.Workspace.Map']);
    expect(results.floorAgain).toBe('0,0,0');

    expect(results.list.checkpoints).toEqual([expect.objectContaining({ id: 'cp1', instances: 9, subtrees: 6, terrain: true })]);
    expect(results.drop).toEqual({ id: 'cp1', dropped: true });
    expect(results.gone).toEqual({ missing: true, id: 'cp1', existing: [] });
    expect(log).toEqual([
      'copy',
      'begin:MCP: changes before revert cp1', 'finish:Commit', 'begin:MCP: revert checkpoint cp1', 'finish:Commit',
      'begin:MCP: changes before revert cp1', 'finish:Commit', 'begin:MCP: revert checkpoint cp1', 'paste:min:min:true', 'finish:Commit',
      'begin:MCP: changes before revert cp1', 'finish:Commit', 'begin:MCP: revert checkpoint cp1', 'finish:Commit',
    ]);
  });

  test('create refuses bad roots, oversized trees and taken ids, and names checkpoints itself', () => {
    const { results } = runWorld([
      { name: 'overlap', code: create({ roots: ['game.Workspace', 'game.Workspace.Map'], explicit_roots: true }) },
      { name: 'whole', code: create({ roots: ['game'], explicit_roots: true }) },
      { name: 'terrain', code: create({ roots: ['game.Workspace.Terrain'], explicit_roots: true }) },
      { name: 'missing', code: create({ roots: ['game.Nope'], explicit_roots: true }) },
      { name: 'big', code: create({ max_instances: 3 }) },
      { name: 'first', code: create() },
      { name: 'second', code: create({ roots: ['game.Workspace.Map'], explicit_roots: true }) },
      { name: 'taken', code: create({ id: 'cp2' }) },
      { name: 'ambiguous', code: changes() },
      { name: 'nothingToDo', code: revert() },
      { luau: '_G.__Lumen_CHECKPOINTS.legacy = { id = "legacy", createdAt = 0, roots = {} }' },
      { name: 'legacy', code: changes('legacy') },
    ]);
    expect(results.overlap.error).toBe('roots overlap: game.Workspace.Map and game.Workspace');
    expect(results.whole.error).toMatch(/game cannot be a root/);
    expect(results.terrain.error).toMatch(/Terrain cannot be a root, pass include_terrain/);
    expect(results.missing.error).toBe('roots not found: game.Nope');
    expect(results.big.error).toMatch(/^9 instances under the roots exceed max_instances 3/);
    expect(results.first.id).toBe('cp1');
    expect(results.second).toMatchObject({ id: 'cp2', roots: ['game.Workspace.Map'], subtrees: 1, instances: 3 });
    expect(results.taken.error).toMatch(/checkpoint cp2 already exists/);
    expect(results.ambiguous.error).toBe('pass id, there are several checkpoints: cp1, cp2');
    expect(results.nothingToDo).toEqual({ id: 'cp1', unchanged: true, skipped: [], unmatchedPaths: [], truncated: false });
    expect(results.legacy.error).toBe('checkpoint legacy was made by an older build of this tool, drop it and create a new one');
  });

  test('a root below a service is one subtree, so moving, deleting or renaming it is caught and reverted', () => {
    const { results } = runWorld([
      {
        luau: String.raw`
local StarterPlayer = service("StarterPlayer")
W.Scripts = new("StarterPlayerScripts", "StarterPlayerScripts", StarterPlayer)
new("Folder", "A", W.Scripts)
new("Folder", "B", W.Scripts)
`,
      },
      { name: 'create', code: create({ roots: ['game.Workspace.Map', 'game.StarterPlayer.StarterPlayerScripts'], explicit_roots: true }) },
      { luau: 'W.Map.Parent = ReplicatedStorage' },
      { name: 'moved', code: changes() },
      { name: 'revertMoved', code: revert() },
      { luau: 'RESULTS.afterMove = { inWorkspace = Workspace:FindFirstChild("Map") ~= nil, leftReplicated = ReplicatedStorage:FindFirstChild("Map") == nil, map = names(Workspace:FindFirstChild("Map")) }' },
      { luau: 'Workspace:FindFirstChild("Map"):Destroy()' },
      { name: 'destroyed', code: changes() },
      { name: 'revertDestroyed', code: revert() },
      { luau: 'Workspace:FindFirstChild("Map").Name = "Level"' },
      { name: 'renamed', code: changes() },
      { name: 'revertRenamed', code: revert(['game.Workspace.Map']) },
      { luau: 'RESULTS.final = { workspace = names(Workspace), map = names(Workspace:FindFirstChild("Map")), scripts = names(W.Scripts) }' },
      { name: 'clean', code: changes() },
    ]);
    expect(results.create).toMatchObject({
      id: 'cp1', roots: ['game.Workspace.Map', 'game.StarterPlayer.StarterPlayerScripts'], subtrees: 3, instances: 5,
    });
    expect(results.moved).toMatchObject({
      clean: false,
      counts: { added: 0, removed: 0, modified: 1 },
      modified: [{ path: 'game.ReplicatedStorage.Map', class: 'Model', fields: ['Parent'] }],
      subtrees: [{ path: 'game.Workspace.Map', change: 'changed' }],
    });
    expect(results.revertMoved.replaced).toEqual(['game.Workspace.Map']);
    expect(results.afterMove).toEqual({ inWorkspace: true, leftReplicated: true, map: ['Floor', 'Wall'] });
    expect(results.destroyed).toMatchObject({ counts: { added: 0, removed: 3, modified: 0 }, removed: [{ path: 'game.Workspace.Map', class: 'Model' }] });
    expect(results.revertDestroyed.replaced).toEqual(['game.Workspace.Map']);
    expect(results.renamed).toMatchObject({
      modified: [{ path: 'game.Workspace.Level', class: 'Model', fields: ['Name'] }],
      subtrees: [{ path: 'game.Workspace.Map', change: 'changed' }],
    });
    expect(results.revertRenamed).toMatchObject({ replaced: ['game.Workspace.Map'], unmatchedPaths: [] });
    expect(results.final).toEqual({ workspace: ['Baseplate', 'Camera', 'Ghost', 'Map', 'Terrain'], map: ['Floor', 'Wall'], scripts: ['A', 'B'] });
    expect(results.clean.clean).toBe(true);
  });

  test('revert repoints references between restored subtrees and from untouched ones, and reports dangling ones', () => {
    const { results } = runWorld([
      {
        luau: String.raw`
W.Door = new("Part", "Door", Workspace, { CFrame = "door" })
new("WeldConstraint", "Weld", W.Door, { Part0 = W.Door, Part1 = W.Baseplate })
new("ObjectValue", "Lost", W.Door, { Value = W.Ghost })
W.Link = new("ObjectValue", "Link", ReplicatedStorage, { Value = W.Door })
local function links()
	local door = Workspace:FindFirstChild("Door")
	local base = Workspace:FindFirstChild("Baseplate")
	local weld = door:FindFirstChild("Weld")
	return {
		freshDoor = door ~= W.Door,
		freshBase = base ~= W.Baseplate,
		part0 = weld.Part0 == door,
		part1 = weld.Part1 == base,
		link = W.Link.Value == door,
	}
end
`,
      },
      { name: 'create', code: create() },
      { luau: 'W.Baseplate.CFrame = "moved"\nW.Door.CFrame = "moved"\nW.Ghost:Destroy()' },
      { name: 'revertBoth', code: revert() },
      { luau: 'RESULTS.both = links()' },
      { name: 'afterBoth', code: changes() },
      { luau: 'Workspace:FindFirstChild("Baseplate").CFrame = "again"' },
      { name: 'revertBase', code: revert(['game.Workspace.Baseplate']) },
      { luau: 'RESULTS.base = links()' },
      { luau: 'Workspace:FindFirstChild("Door").CFrame = "again"' },
      { name: 'revertDoor', code: revert(['game.Workspace.Door']) },
      { luau: 'RESULTS.door = links()' },
      { name: 'afterDoor', code: changes() },
    ]);
    const linked = { freshDoor: true, freshBase: true, part0: true, part1: true, link: true };
    expect(results.revertBoth).toMatchObject({
      counts: { replaced: 2, removed: 0, skipped: 1, relinked: 2, dangling: 1 },
      replaced: ['game.Workspace.Baseplate', 'game.Workspace.Door'],
      danglingReferences: [{ path: 'game.Workspace.Door.Lost', property: 'Value', target: 'nil.Ghost' }],
    });
    expect(results.both).toEqual(linked);
    expect(results.afterBoth.counts).toEqual({ added: 0, removed: 1, modified: 0 });
    expect(results.revertBase).toMatchObject({ replaced: ['game.Workspace.Baseplate'], counts: { relinked: 1, dangling: 0 } });
    expect(results.revertBase.danglingReferences).toBeUndefined();
    expect(results.base).toEqual(linked);
    expect(results.revertDoor).toMatchObject({ replaced: ['game.Workspace.Door'], counts: { relinked: 2, dangling: 1 } });
    expect(results.door).toEqual(linked);
    expect(results.afterDoor.counts).toEqual({ added: 0, removed: 1, modified: 0 });
  });


  test('a Ctrl+Z of a revert brings back the old subtree with its fingerprints, and paths match in any form', () => {
    const { results } = runWorld([
      { name: 'create', code: create() },
      { luau: 'W.Floor.CFrame = "9,0,0"' },
      { name: 'revertMap', code: revert(['Workspace["Map"]']) },
      { luau: 'RESULTS.replacedMap = Workspace:FindFirstChild("Map") ~= W.Map\nundo()\nRESULTS.oldMapBack = Workspace:FindFirstChild("Map") == W.Map' },
      { name: 'afterUndo', code: changes() },
      { name: 'again', code: revert() },
      { luau: 'RESULTS.floor = Workspace:FindFirstChild("Map"):FindFirstChild("Floor").CFrame' },
      { name: 'clean', code: changes() },
    ]);
    expect(results.revertMap).toMatchObject({ replaced: ['game.Workspace.Map'], unmatchedPaths: [] });
    expect(results.replacedMap).toBe(true);
    expect(results.oldMapBack).toBe(true);
    expect(results.afterUndo).toMatchObject({
      counts: { added: 0, removed: 0, modified: 1 },
      modified: [{ path: 'game.Workspace.Map.Floor', class: 'Part', fields: ['CFrame'] }],
      subtrees: [{ path: 'game.Workspace.Map', change: 'changed' }],
    });
    expect(results.again.replaced).toEqual(['game.Workspace.Map']);
    expect(results.floor).toBe('0,0,0');
    expect(results.clean.clean).toBe(true);
  });

  test('revert changes nothing without a recording, and a failure says whether Studio cancelled it', () => {
    const { results, log } = runWorld([
      { name: 'create', code: create() },
      { luau: 'W.Config.Value = "b"\nW.Main.Name = "Renamed"\nW.Baseplate.CFrame = "1,1,1"\nW.Floor.CFrame = "9,0,0"' },
      { name: 'before', code: changes() },
      { luau: 'FLAGS.busy = true' },
      { name: 'busy', code: revert() },
      { luau: 'FLAGS.busy = false' },
      { name: 'afterBusy', code: changes() },
      { luau: 'FLAGS.failParent = "Baseplate"' },
      { name: 'cancelled', code: revert() },
      {
        luau: String.raw`
RESULTS.cancelledWorld = {
	config = ReplicatedStorage:FindFirstChild("Config") == W.Config,
	main = ServerScriptService:FindFirstChild("Renamed") == W.Main,
	baseplate = W.Baseplate.Parent == Workspace,
	map = Workspace:FindFirstChild("Map") == W.Map,
}
`,
      },
      { name: 'afterCancel', code: changes() },
      { luau: 'FLAGS.cancelFails = true' },
      { name: 'stuck', code: revert() },
      { luau: 'FLAGS.cancelFails = false\nFLAGS.failParent = nil' },
      { name: 'afterStuck', code: changes() },
      { name: 'final', code: revert() },
      { name: 'clean', code: changes() },
      { luau: 'FLAGS.running = true' },
      { name: 'running', code: changes() },
    ]);
    const before = results.before;
    expect(before.counts).toEqual({ added: 0, removed: 0, modified: 4 });
    expect(results.busy.error).toMatch(/another edit by this plugin is still recording, so nothing was changed/);
    expect(log.filter((entry) => entry === 'busy')).toHaveLength(10);
    expect(results.afterBusy).toMatchObject({ counts: before.counts, modified: before.modified, added: [], removed: [] });

    expect(results.cancelled.error).toMatch(/^revert failed and Studio cancelled its partial changes, so the place is as before: .*mock parent failure/);
    expect(results.cancelledWorld).toEqual({ config: true, main: true, baseplate: true, map: true });
    expect(results.afterCancel).toMatchObject({ counts: before.counts, modified: before.modified, added: [], removed: [] });

    expect(results.stuck.error).toMatch(
      /^revert failed part way and Studio could not cancel it, 2 subtrees stay replaced \(game\.ReplicatedStorage\.Config, game\.ServerScriptService\.Main\)/,
    );
    expect(results.afterStuck).toMatchObject({
      counts: { added: 0, removed: 1, modified: 1 },
      removed: [{ path: 'game.Workspace.Baseplate', class: 'Part' }],
      modified: [{ path: 'game.Workspace.Map.Floor', class: 'Part', fields: ['CFrame'] }],
    });
    expect(results.final.replaced).toEqual(['game.Workspace.Baseplate', 'game.Workspace.Map']);
    expect(results.clean.clean).toBe(true);
    expect(results.running.error).toMatch(/only works on the edit DataModel/);
  });

  test('only the viewer camera is skipped, other cameras in Workspace are tracked', () => {
    const { results } = runWorld([
      { luau: 'W.Cutscene = new("Camera", "CutsceneCam", Workspace, { CFrame = "c" })' },
      { name: 'create', code: create() },
      { luau: 'W.Cutscene.CFrame = "d"\nW.Camera.CFrame = "viewer"\nnew("Camera", "Spare", Workspace)' },
      { name: 'found', code: changes() },
      { name: 'reverted', code: revert() },
      {
        luau: String.raw`
RESULTS.after = {
	cutscene = Workspace:FindFirstChild("CutsceneCam").CFrame,
	spareGone = Workspace:FindFirstChild("Spare") == nil,
	viewer = W.Camera.CFrame,
	current = Workspace.CurrentCamera == W.Camera,
}
`,
      },
    ]);
    expect(results.create).toMatchObject({ subtrees: 7, instances: 10 });
    expect(results.found).toMatchObject({
      counts: { added: 1, removed: 0, modified: 1 },
      added: [{ path: 'game.Workspace.Spare', class: 'Camera' }],
      modified: [{ path: 'game.Workspace.CutsceneCam', class: 'Camera', fields: ['CFrame'] }],
    });
    expect(results.reverted).toMatchObject({ replaced: ['game.Workspace.CutsceneCam'], removed: ['game.Workspace.Spare'] });
    expect(results.after).toEqual({ cutscene: 'c', spareGone: true, viewer: 'viewer', current: true });
  });

  test('big change sets come back counted but capped', () => {
    const { results } = runWorld([
      { luau: 'for i = 1, 120 do new("StringValue", "V" .. i, ReplicatedStorage, { Value = "a" }) end' },
      { name: 'create', code: create({ roots: ['game.ReplicatedStorage'], explicit_roots: true }) },
      { luau: 'for _, value in ReplicatedStorage:GetChildren() do if string.sub(value.Name, 1, 1) == "V" then value.Value = "b" end end' },
      { name: 'changes', code: changes('cp1', 5) },
      { name: 'revert', code: revert(['game.ReplicatedStorage']) },
      {
        luau: String.raw`
local restored = 0
for _, value in ReplicatedStorage:GetChildren() do
	if string.sub(value.Name, 1, 1) == "V" and value.Value == "a" then restored += 1 end
end
RESULTS.restored = restored
`,
      },
    ]);
    expect(results.changes.counts.modified).toBe(120);
    expect(results.changes.modified).toHaveLength(5);
    expect(results.changes.subtrees).toHaveLength(5);
    expect(results.changes.truncated).toBe(true);
    expect(results.revert.counts.replaced).toBe(120);
    expect(results.revert.replaced).toHaveLength(100);
    expect(results.revert.truncated).toBe(true);
    expect(results.restored).toBe(120);
  });
});
