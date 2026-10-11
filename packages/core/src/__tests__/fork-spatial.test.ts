import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { RobloxStudioTools } from '../tools/index.js';
import type { ForkHost, PeerTarget } from '../tools/fork-tools.js';
import { analyzeJumps, compareBoxes, jumpReach, jumpStats, spatialFeature, type Box } from '../tools/fork/spatial.js';
import { spatialAuditLuau, spatialBoundsLuau, spatialReachLuau } from '../tools/fork/spatial-luau.js';

type Call = { endpoint: string; code: string; peerId: string; timeoutMs?: number };

function fakeHost(peers: PeerTarget[], reply: (call: Call) => unknown) {
  const calls: Call[] = [];
  const routed: Array<{ target?: string; instanceId?: string }> = [];
  const host: ForkHost = {
    peerTargets: async (target, instanceId) => {
      routed.push({ target, instanceId });
      if (target === 'all') return peers;
      return peers.filter((peer) => peer.role === target);
    },
    requestPeer: async (endpoint, data, peerId, timeoutMs) => {
      const call = { endpoint, code: (data as { code: string }).code, peerId, timeoutMs };
      calls.push(call);
      return reply(call);
    },
    soloPlaytest: async () => ({ content: [] }),
    getRuntimeLogs: async () => ({ content: [] }),
  };
  return { host, calls, routed };
}

const ok = (value: unknown) => ({ success: true, returnValue: JSON.stringify(value) });
const EDIT = [{ role: 'edit', peerId: 'e' }, { role: 'server', peerId: 's' }];

async function check(host: ForkHost, body: Record<string, unknown>) {
  const result = await spatialFeature.handlers.spatial_check({ forkHost: host } as unknown as RobloxStudioTools, body);
  return JSON.parse(result.content[0].text!);
}

const box = (min: [number, number, number], max: [number, number, number], name?: string): Box => ({
  path: name, min, max, extents: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
});

describe('spatial_check jump math', () => {
  const defaults = jumpStats({ gravity: 196.2, walkSpeed: 16, useJumpPower: false, jumpHeight: 7.2, source: 'StarterPlayer' });

  test('JumpPower converts to a height through the launch speed', () => {
    const stats = jumpStats({ gravity: 196.2, walkSpeed: 16, useJumpPower: true, jumpPower: 50 });
    expect(stats.jumpHeight).toBeCloseTo(2500 / 392.4, 6);
    expect(stats.jumpVelocity).toBeCloseTo(50, 6);
  });

  test('overrides win over Studio values and are named in the source', () => {
    const stats = jumpStats({ gravity: 196.2, walkSpeed: 16, jumpHeight: 7.2, source: 'StarterPlayer' }, { walk_speed: 24 });
    expect(stats.walkSpeed).toBe(24);
    expect(stats.gravity).toBe(196.2);
    expect(stats.jumpHeight).toBe(7.2);
    expect(stats.source).toBe('StarterPlayer with overrides');
    expect(jumpStats({}).gravity).toBe(196.2);
    expect(() => jumpStats({ gravity: 0 })).toThrow(/never comes back down/);
  });

  test('airtime follows (v0 + sqrt(v0^2 - 2gr)) / g', () => {
    const v0 = Math.sqrt(2 * 196.2 * 7.2);
    expect(jumpReach(defaults, 0)!.airtime).toBeCloseTo((2 * v0) / 196.2, 9);
    expect(jumpReach(defaults, 0)!.reach).toBeCloseTo((16 * 2 * v0) / 196.2, 9);
    expect(jumpReach(defaults, 7.2)!.airtime).toBeCloseTo(v0 / 196.2, 6);
    expect(jumpReach(defaults, -10)!.airtime).toBeGreaterThan(jumpReach(defaults, 0)!.airtime);
    expect(jumpReach(defaults, 7.3)).toBeUndefined();
  });

  test('gaps use the closest box edges and the rise between tops', () => {
    const flatReach = jumpReach(defaults, 0)!.reach;
    const jumps = analyzeJumps([
      box([-2, 9.5, -2], [2, 10.5, 2], 'A'),
      box([10, 9.5, -2], [14, 10.5, 2], 'B'),
      box([23, 9.5, -2], [27, 10.5, 2], 'C'),
      box([24, 12, 3], [28, 18.5, 7], 'D'),
      box([30, 0, 30], [32, 1, 32], 'E'),
    ], defaults);
    expect(jumps[0]).toMatchObject({ from: 'A', to: 'B', gap: 8, rise: 0, jumpable: true, limitedBy: 'distance' });
    expect(jumps[0].margin).toBeCloseTo(flatReach - 8, 1);
    expect(jumps[1]).toMatchObject({ gap: 9, jumpable: false });
    expect(jumps[2]).toMatchObject({ gap: 1, rise: 8, jumpable: false, limitedBy: 'height', margin: -0.8, reach: 0 });
    expect(jumps[3].gap).toBeCloseTo(Math.hypot(2, 23), 2);
    expect(jumps[3].rise).toBe(-17.5);
  });

  test('a character that cannot jump only clears drops', () => {
    const grounded = jumpStats({ gravity: 196.2, walkSpeed: 16 }, { jump_height: 0 });
    expect(grounded.jumpVelocity).toBe(0);
    const [level, drop] = analyzeJumps([box([0, 0, 0], [4, 1, 4]), box([5, 0, 0], [9, 1, 4]), box([10, -9, 0], [14, -4, 4])], grounded);
    expect(level.jumpable).toBe(false);
    expect(drop.jumpable).toBe(true);
  });

  test('measure compares boxes per axis', () => {
    const result = compareBoxes(box([0, 0, 0], [2, 2, 2], 'A'), box([5, 6, 0], [7, 8, 2], 'B'));
    expect(result.offset).toEqual([5, 6, 0]);
    expect(result.centerDistance).toBeCloseTo(Math.hypot(5, 6), 3);
    expect(result.closestDistance).toBeCloseTo(5, 3);
    expect(result.horizontalGap).toBe(3);
    expect(result.verticalGap).toBe(4);
    expect(result.rise).toBe(6);
    expect(result.overlapping).toBe(false);
    const inside = compareBoxes(box([0, 0, 0], [4, 4, 4]), { min: [1, 1, 1], max: [1, 1, 1], extents: [0, 0, 0] });
    expect(inside.overlapping).toBe(false);
    expect(inside.closestDistance).toBe(0);
    expect(inside.to).toMatchObject({ position: [1, 1, 1] });
    const crossing = compareBoxes(box([0, 0, 0], [4, 4, 4]), box([3, 1, 1], [6, 2, 2]));
    expect(crossing.overlapping).toBe(true);
    expect(crossing.overlap).toEqual([1, 1, 1]);
  });
});

describe('spatial_check routing', () => {
  test('audit runs on the edit peer by default with clamped arguments and the given instance id', async () => {
    const { host, calls, routed } = fakeHost(EDIT, () => ok({ counts: { floating: 0 }, floating: [] }));
    const result = await check(host, { mode: 'audit', limit: 500, instance_id: 'studio-1' });
    expect(routed).toEqual([{ target: 'edit', instanceId: 'studio-1' }]);
    expect(calls[0]).toMatchObject({ endpoint: '/api/execute-luau', peerId: 'e' });
    expect(calls[0].code).toContain('"root":"game.Workspace"');
    expect(calls[0].code).toContain('"limit":100');
    expect(calls[0].code).not.toContain('"paths"');
    expect(calls[0].timeoutMs).toBeGreaterThan(60_000);
    expect(result).toEqual({ peer: 'edit', counts: { floating: 0 }, floating: [] });
  });

  test('audit passes paths and a target peer', async () => {
    const { host, calls } = fakeHost(EDIT, () => ok({}));
    await check(host, { mode: 'audit', target: 'server', paths: ['game.Workspace.New', 'game.Workspace.Other'], tolerance: 0.2 });
    expect(calls[0].peerId).toBe('s');
    expect(calls[0].code).toContain('"paths":["game.Workspace.New","game.Workspace.Other"]');
    expect(calls[0].code).toContain('"tolerance":0.2');
    await check(host, { mode: 'audit', paths: [] });
    expect(calls[1].code).not.toContain('"paths"');
  });

  test('audit refuses path lists it would have to cut or filter', async () => {
    const { host, calls } = fakeHost(EDIT, () => ok({}));
    const many = Array.from({ length: 201 }, (_, i) => `game.Workspace.P${i}`);
    await expect(check(host, { mode: 'audit', paths: many })).rejects.toThrow(/1 to 200/);
    await expect(check(host, { mode: 'audit', paths: ['game.Workspace.New', 3] })).rejects.toThrow(/1 to 200/);
    await expect(check(host, { mode: 'audit', paths: ['game.Workspace.New', ''] })).rejects.toThrow(/1 to 200/);
    await expect(check(host, { mode: 'audit', paths: 'game.Workspace.New' })).rejects.toThrow(/1 to 200/);
    expect(calls).toHaveLength(0);
    await check(host, { mode: 'audit', paths: many.slice(0, 200) });
    expect(calls).toHaveLength(1);
  });

  test('gaps combines Studio boxes with character overrides', async () => {
    const { host } = fakeHost(EDIT, () => ok({
      boxes: [
        { path: 'game.Workspace.A', min: [-2, 9.5, -2], max: [2, 10.5, 2], extents: [4, 1, 4] },
        { path: 'game.Workspace.B', min: [10, 9.5, -2], max: [14, 10.5, 2], extents: [4, 1, 4] },
      ],
      character: { gravity: 196.2, walkSpeed: 16, useJumpPower: false, jumpHeight: 7.2, source: 'StarterPlayer' },
    }));
    const normal = await check(host, { mode: 'gaps', platforms: ['game.Workspace.A', 'game.Workspace.B'] });
    expect(normal.allJumpable).toBe(true);
    expect(normal.character).toMatchObject({ walkSpeed: 16, jumpHeight: 7.2, source: 'StarterPlayer' });
    const slow = await check(host, { mode: 'gaps', platforms: ['game.Workspace.A', 'game.Workspace.B'], character: { walk_speed: 8 } });
    expect(slow.allJumpable).toBe(false);
    expect(slow.jumps[0].margin).toBeLessThan(0);
    expect(slow.character.source).toBe('StarterPlayer with overrides');
  });

  test('reach forwards a no-jump override and measure compares the two boxes', async () => {
    const { host, calls } = fakeHost(EDIT, (call) => (call.code.includes('PathfindingService')
      ? ok({ status: 'Success', waypoints: 4 })
      : ok({ boxes: [
        { path: 'game.Workspace.A', min: [0, 0, 0], max: [2, 2, 2], extents: [2, 2, 2], clearance: 0 },
        { min: [0, 10, 0], max: [0, 10, 0], extents: [0, 0, 0], clearance: 8, below: 'game.Workspace.A' },
      ] })));
    const reach = await check(host, { mode: 'reach', from: 'game.Workspace.A', to: [0, 5, 0], character: { jump_height: 0 } });
    expect(reach).toEqual({ peer: 'edit', status: 'Success', waypoints: 4 });
    expect(calls[0].code).toContain('"can_jump":false');
    expect(calls[0].code).toContain('"to":[0,5,0]');
    const measure = await check(host, { mode: 'measure', from: 'game.Workspace.A', to: [0, 10, 0] });
    expect(calls[1].code).toContain('"ground":true');
    expect(measure).toMatchObject({ peer: 'edit', verticalGap: 8, closestDistance: 8, overlapping: false });
    expect(measure.to).toMatchObject({ position: [0, 10, 0], groundClearance: 8, ground: 'game.Workspace.A' });
    await check(host, { mode: 'measure', a: 'game.Workspace.A', b: [0, 10, 0] });
    expect(calls[2].code).toContain('"targets":["game.Workspace.A",[0,10,0]]');
  });

  test('rejects bad arguments before touching Studio', async () => {
    const { host, calls } = fakeHost(EDIT, () => ok({}));
    await expect(check(host, { mode: 'look' })).rejects.toThrow(/mode must be/);
    await expect(check(host, { mode: 'gaps', platforms: ['game.Workspace.A'] })).rejects.toThrow(/2 to 50/);
    await expect(check(host, { mode: 'reach', from: [1, 2], to: 'x' })).rejects.toThrow(/from must be/);
    await expect(check(host, { mode: 'measure', from: 'x' })).rejects.toThrow(/to must be/);
    await expect(check(host, { mode: 'gaps', platforms: ['a', 'b'], character: { walk_speed: -1 } })).rejects.toThrow(/non-negative/);
    expect(calls).toHaveLength(0);
  });

  test('surfaces snippet errors and ambiguous targets', async () => {
    const { host } = fakeHost([...EDIT, { role: 'edit', peerId: 'e2' }], () => ok({ error: 'not found: game.Workspace.X' }));
    await expect(check(host, { mode: 'measure', from: 'game.Workspace.X', to: [0, 0, 0] })).rejects.toThrow(/2 matched/);
    const single = fakeHost(EDIT, () => ok({ error: 'not found: game.Workspace.X' }));
    await expect(check(single.host, { mode: 'measure', from: 'game.Workspace.X', to: [0, 0, 0] })).rejects.toThrow('not found: game.Workspace.X');
  });
});

type SchemaNode = { type?: unknown; items?: unknown; properties?: Record<string, unknown>; anyOf?: unknown[] };

// The shared items rule only matches type: 'array', so a type union without items would slip past it.
function schemaProblems(node: SchemaNode, at: string): string[] {
  const problems: string[] = [];
  if (Array.isArray(node.type)) problems.push(`${at} uses a type union`);
  if (node.type === 'array' && node.items === undefined) problems.push(`${at} has no items`);
  for (const [name, child] of Object.entries(node.properties ?? {})) problems.push(...schemaProblems(child as SchemaNode, `${at}.${name}`));
  if (node.items) problems.push(...schemaProblems(node.items as SchemaNode, `${at}[]`));
  (node.anyOf ?? []).forEach((branch, i) => problems.push(...schemaProblems(branch as SchemaNode, `${at}|${i}`)));
  return problems;
}

describe('spatial_check schema', () => {
  test('spots are a string or number array union that strict clients accept', () => {
    const [definition] = spatialFeature.definitions;
    expect(schemaProblems(definition.inputSchema as SchemaNode, definition.name)).toEqual([]);
    const { properties } = definition.inputSchema as { properties: Record<string, SchemaNode> };
    for (const name of ['from', 'to']) {
      expect(properties[name].anyOf).toEqual([{ type: 'string' }, { type: 'array', items: { type: 'number' } }]);
    }
  });
});

const auditOf = (args: Partial<Parameters<typeof spatialAuditLuau>[0]>) =>
  spatialAuditLuau({ root: 'game.Workspace', limit: 20, tolerance: 0.05, max_parts: 20000, time_budget_s: 60, ...args });

const SNIPPETS: Record<string, string> = {
  audit: auditOf({}),
  auditPaths: auditOf({ paths: ['game.Workspace.Coin', 'game.Workspace.Missing'], limit: 5, max_parts: 100, time_budget_s: 5 }),
  auditGame: auditOf({ root: 'game' }),
  auditStorage: auditOf({ root: 'game.ReplicatedStorage.Level' }),
  gaps: spatialBoundsLuau({ targets: ['game.Workspace.P1', 'game.Workspace.P2'], ground: false, character: true, tolerance: 0.05 }),
  measure: spatialBoundsLuau({ targets: ['game.Workspace.Props.Box1', [0, 50, 0]], ground: true, character: false, tolerance: 0.05 }),
  reach: spatialReachLuau({ from: 'game.Workspace.P1', to: [12, 13, 100] }),
};

const compiler = spawnSync('luau-compile', ['--help']).error ? undefined : 'luau-compile';
const interpreter = spawnSync('luau', ['--help']).error ? undefined : 'luau';

function scratch(name: string, code: string): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fork-spatial-')), `${name}.luau`);
  fs.writeFileSync(file, code);
  return file;
}

describe('spatial_check Luau', () => {
  (compiler ? test.each(Object.entries(SNIPPETS)) : test.skip.each(Object.entries(SNIPPETS)))('%s compiles as Luau', (name, code) => {
    const result = spawnSync(compiler!, ['--null', scratch(name, code)], { encoding: 'utf8' });
    expect(result.stderr + result.stdout).not.toMatch(/error/i);
    expect(result.status).toBe(0);
  });
});

// A tiny engine stand in with yaw only CFrames, box queries, and an encoder that refuses whatever the plugin's JSONEncode would mangle.
const MOCK_WORLD = String.raw`
local V = {}
V.__index = function(v, key)
	if key == "Magnitude" then return math.sqrt(v.X * v.X + v.Y * v.Y + v.Z * v.Z) end
	return nil
end
local function v3(x, y, z) return setmetatable({ X = x, Y = y, Z = z }, V) end
V.__add = function(a, b) return v3(a.X + b.X, a.Y + b.Y, a.Z + b.Z) end
V.__sub = function(a, b) return v3(a.X - b.X, a.Y - b.Y, a.Z - b.Z) end
V.__unm = function(a) return v3(-a.X, -a.Y, -a.Z) end
V.__mul = function(a, b)
	if type(a) == "number" then return v3(b.X * a, b.Y * a, b.Z * a) end
	if type(b) == "number" then return v3(a.X * b, a.Y * b, a.Z * b) end
	return v3(a.X * b.X, a.Y * b.Y, a.Z * b.Z)
end
V.__div = function(a, b)
	if type(b) == "number" then return v3(a.X / b, a.Y / b, a.Z / b) end
	return v3(a.X / b.X, a.Y / b.Y, a.Z / b.Z)
end
Vector3 = { new = function(x, y, z) return v3(x or 0, y or 0, z or 0) end, zero = v3(0, 0, 0) }

local C = {}
local IDENTITY = { 1, 0, 0, 0, 1, 0, 0, 0, 1 }
local function cf(p, R) return setmetatable({ _p = p, _R = R }, C) end
local function toObjectSpace(self, other)
	local R, O = self._R, other._R
	local d = other._p - self._p
	local p = v3(R[1] * d.X + R[4] * d.Y + R[7] * d.Z, R[2] * d.X + R[5] * d.Y + R[8] * d.Z, R[3] * d.X + R[6] * d.Y + R[9] * d.Z)
	local M = {}
	for i = 0, 2 do
		for j = 0, 2 do
			local s = 0
			for k = 0, 2 do s += R[k * 3 + i + 1] * O[k * 3 + j + 1] end
			M[i * 3 + j + 1] = s
		end
	end
	return cf(p, M)
end
C.__index = function(c, key)
	local R = rawget(c, "_R")
	if key == "Position" then return rawget(c, "_p") end
	if key == "RightVector" then return v3(R[1], R[4], R[7]) end
	if key == "UpVector" then return v3(R[2], R[5], R[8]) end
	if key == "LookVector" then return v3(-R[3], -R[6], -R[9]) end
	if key == "ToObjectSpace" then return toObjectSpace end
	return nil
end
CFrame = {
	new = function(x, y, z)
		if type(x) == "table" then return cf(x, IDENTITY) end
		return cf(v3(x, y, z), IDENTITY)
	end,
	yaw = function(p, angle)
		local c, s = math.cos(angle), math.sin(angle)
		return cf(p, { c, 0, s, 0, 1, 0, -s, 0, c })
	end,
}

Enum = {
	RaycastFilterType = { Exclude = "Exclude" },
	PathStatus = { Success = { Name = "Success" } },
	PathWaypointAction = { Walk = { Name = "Walk" }, Jump = { Name = "Jump" } },
}
RaycastParams = { new = function() return { FilterDescendantsInstances = {}, RespectCanCollide = false } end }
OverlapParams = { new = function() return { FilterDescendantsInstances = {}, RespectCanCollide = false, MaxParts = 0 } end }
task = { wait = function() end }

local CLASSES = {
	DataModel = { "DataModel", "Instance" },
	Workspace = { "Workspace", "WorldRoot", "Model", "PVInstance", "Instance" },
	Terrain = { "Terrain", "BasePart", "PVInstance", "Instance" },
	Part = { "Part", "FormFactorPart", "BasePart", "PVInstance", "Instance" },
	Model = { "Model", "PVInstance", "Instance" },
	Folder = { "Folder", "Instance" },
	Camera = { "Camera", "Instance" },
	Players = { "Players", "Instance" },
	RunService = { "RunService", "Instance" },
	StarterPlayer = { "StarterPlayer", "Instance" },
	PathfindingService = { "PathfindingService", "Instance" },
	ReplicatedStorage = { "ReplicatedStorage", "Instance" },
	Humanoid = { "Humanoid", "Instance" },
}
local Methods = {}
local I = { __index = function(_, key) return Methods[key] end }
local function make(class, name, parent, props)
	local o = setmetatable({ ClassName = class, Name = name, _children = {} }, I)
	for key, value in props or {} do o[key] = value end
	if parent then
		o.Parent = parent
		table.insert(parent._children, o)
	end
	return o
end
local function isDescendant(o, ancestor)
	local current = o.Parent
	while current do
		if current == ancestor then return true end
		current = current.Parent
	end
	return false
end
function Methods.IsA(self, class)
	for _, name in CLASSES[self.ClassName] do
		if name == class then return true end
	end
	return false
end
function Methods.GetChildren(self) return table.clone(self._children) end
function Methods.GetDescendants(self)
	local out = {}
	local function walk(o)
		for _, child in o._children do
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
function Methods.FindFirstChildOfClass(self, class)
	for _, child in self._children do
		if child.ClassName == class then return child end
	end
	return nil
end
function Methods.FindFirstAncestorWhichIsA(self, class)
	local current = self.Parent
	while current do
		if current:IsA(class) then return current end
		current = current.Parent
	end
	return nil
end
function Methods.FindFirstAncestorOfClass(self, class)
	local current = self.Parent
	while current do
		if current.ClassName == class then return current end
		current = current.Parent
	end
	return nil
end
function Methods.GetService(self, name)
	for _, child in self._children do
		if child.ClassName == name then return child end
	end
	error("no service " .. tostring(name))
end
function Methods.GetJoints() return {} end
function Methods.GetPlayers() return {} end
function Methods.GetPlayerFromCharacter() return nil end
function Methods.IsRunning() return false end
function Methods.IsServer() return false end

local function aabb(p)
	local R, half = p.CFrame._R, p.Size / 2
	local e = v3(
		math.abs(R[1]) * half.X + math.abs(R[2]) * half.Y + math.abs(R[3]) * half.Z,
		math.abs(R[4]) * half.X + math.abs(R[5]) * half.Y + math.abs(R[6]) * half.Z,
		math.abs(R[7]) * half.X + math.abs(R[8]) * half.Y + math.abs(R[9]) * half.Z
	)
	return p.CFrame._p - e, p.CFrame._p + e
end
local function candidates(world, params)
	local out = {}
	for _, item in Methods.GetDescendants(world) do
		local excluded = false
		for _, entry in params.FilterDescendantsInstances do
			if item == entry or isDescendant(item, entry) then excluded = true end
		end
		if item:IsA("BasePart") and item.ClassName ~= "Terrain" and not excluded and (item.CanCollide or not params.RespectCanCollide) then
			table.insert(out, item)
		end
	end
	return out
end
function Methods.Raycast(self, origin, direction, params)
	assert(direction.X == 0 and direction.Z == 0, "mock rays only point down")
	local best, bestTop
	for _, p in candidates(self, params) do
		local R, c, h = p.CFrame._R, p.CFrame._p, p.Size / 2
		local dx, dz = origin.X - c.X, origin.Z - c.Z
		local lx, lz = R[1] * dx + R[7] * dz, R[3] * dx + R[9] * dz
		local top = c.Y + h.Y
		if math.abs(lx) <= h.X and math.abs(lz) <= h.Z and origin.Y > top and origin.Y + direction.Y <= top and (bestTop == nil or top > bestTop) then
			best, bestTop = p, top
		end
	end
	if best == nil then return nil end
	return { Instance = best, Position = v3(origin.X, bestTop, origin.Z) }
end
function Methods.GetPartBoundsInBox(self, frame, size, params)
	local lo, hi = frame._p - size / 2, frame._p + size / 2
	local out = {}
	for _, p in candidates(self, params) do
		local a, b = aabb(p)
		if a.X <= hi.X and b.X >= lo.X and a.Y <= hi.Y and b.Y >= lo.Y and a.Z <= hi.Z and b.Z >= lo.Z then table.insert(out, p) end
		if params.MaxParts > 0 and #out >= params.MaxParts then break end
	end
	return out
end
function Methods.GetPartsInPart(self, part, params)
	local lo, hi = aabb(part)
	local out = {}
	for _, p in candidates(self, params) do
		local a, b = aabb(p)
		if a.X < hi.X and b.X > lo.X and a.Y < hi.Y and b.Y > lo.Y and a.Z < hi.Z and b.Z > lo.Z then table.insert(out, p) end
	end
	return out
end
function Methods.CreatePath(_, agent)
	assert(agent.AgentRadius and agent.AgentHeight and agent.AgentCanJump ~= nil, "agent parameters")
	local route = { Status = { Name = "NoPath" } }
	function route.ComputeAsync(this, from, to)
		this.Status, this.from, this.to = Enum.PathStatus.Success, from, to
	end
	function route.GetWaypoints(this)
		return {
			{ Position = this.from, Action = Enum.PathWaypointAction.Walk },
			{ Position = (this.from + this.to) / 2 + v3(0, 4, 0), Action = Enum.PathWaypointAction.Jump },
			{ Position = this.to, Action = Enum.PathWaypointAction.Walk },
		}
	end
	return route
end

game = make("DataModel", "Game")
local world = make("Workspace", "Workspace", game, { Gravity = 196.2, FallenPartsDestroyHeight = -500 })
world.Terrain = make("Terrain", "Terrain", world, { CFrame = CFrame.new(0, 0, 0), Size = v3(0, 0, 0), Transparency = 0, CanCollide = true, Anchored = true })
make("Camera", "Camera", world)
make("Players", "Players", game)
make("RunService", "Run Service", game)
make("PathfindingService", "PathfindingService", game)
make("StarterPlayer", "StarterPlayer", game, { CharacterWalkSpeed = 16, CharacterUseJumpPower = false, CharacterJumpPower = 50, CharacterJumpHeight = 7.2 })

local function part(name, parent, at, size, props)
	local p = make("Part", name, parent, {
		CFrame = CFrame.new(at[1], at[2], at[3]), Position = v3(at[1], at[2], at[3]), Size = v3(size[1], size[2], size[3]),
		Anchored = true, CanCollide = true, Transparency = 0, Shape = "Block",
	})
	p.AssemblyRootPart = p
	for key, value in props or {} do p[key] = value end
	return p
end
part("Baseplate", world, { 0, -0.5, 0 }, { 512, 1, 512 })
part("Floater", world, { 0, 10, 0 }, { 4, 1, 4 })
part("Zone", world, { 0, 10, 0 }, { 20, 20, 20 }, { Transparency = 1, CanCollide = false })
part("Trigger", world, { 0, 3, 0 }, { 6, 2, 6 }, { Transparency = 1, CanCollide = false })
part("Crate", world, { 20, 5, 20 }, { 2, 2, 2 }, { Anchored = false })
part("Resting", world, { 30, 1, 30 }, { 2, 2, 2 }, { Anchored = false })
local house = make("Model", "House", world)
part("Floor", house, { 50, 0.5, 50 }, { 10, 1, 10 })
part("Wall", house, { 54.5, 3, 50 }, { 1, 4, 10 })
local props = make("Folder", "Props", world)
part("Box1", props, { -20, 1, -20 }, { 4, 2, 4 })
part("Box2", props, { -18, 1, -20 }, { 4, 2, 4 })
part("Big", world, { 60, 5, -60 }, { 10, 10, 10 })
part("Small", world, { 60, 5, -60 }, { 1, 1, 1 })
part("Speck", world, { 0, 0.02, 10 }, { 0.05, 0.05, 0.05 })
part("Faraway", world, { 5000, 0.5, 0 }, { 2, 1, 2 })
part("Ramp", world, { 100, 1, 100 }, { 10, 2, 10 }, { CFrame = CFrame.yaw(v3(100, 1, 100), math.pi / 4) })
part("Coin", world, { 106, 2.5, 106 }, { 1, 1, 1 })
part("P1", world, { 0, 10, 100 }, { 4, 1, 4 })
part("P2", world, { 12, 10, 100 }, { 4, 1, 4 })
part("Gem", world, { 0, 11, 100 }, { 1, 1, 1 })
part("Ghostly", world, { 40, 5, 40 }, { 2, 2, 2 }, { Anchored = false, CanCollide = false })
part("Sky", world, { -60, 50, 60 }, { 20, 1, 20 })
part("Prop", world, { -60, 51.3, 60 }, { 2, 2, 2 })

local function encode(v)
	local kind = type(v)
	if kind == "nil" then return "null" end
	if kind == "boolean" then return tostring(v) end
	if kind == "number" then
		assert(v == v and math.abs(v) ~= math.huge, "non-finite number")
		return string.format("%.17g", v)
	end
	if kind == "string" then
		return '"' .. (string.gsub(v, '[%c"\\]', function(ch) return string.format("\\u%04x", string.byte(ch)) end)) .. '"'
	end
	assert(kind == "table" and getmetatable(v) == nil, "not a plain value: " .. tostring(v))
	if next(v) == nil then return "[]" end
	local out, keys = {}, 0
	for _ in v do keys += 1 end
	if #v > 0 then
		assert(keys == #v, "mixed or sparse table")
		for i = 1, #v do out[i] = encode(v[i]) end
		return "[" .. table.concat(out, ",") .. "]"
	end
	for key, item in v do
		assert(type(key) == "string", "non-string key " .. tostring(key))
		table.insert(out, encode(key) .. ":" .. encode(item))
	end
	return "{" .. table.concat(out, ",") .. "}"
end
`;

function luaLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'nil';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `{ ${value.map(luaLiteral).join(', ')} }`;
  return `{ ${Object.entries(value as Record<string, unknown>).map(([key, item]) => `[${JSON.stringify(key)}] = ${luaLiteral(item)}`).join(', ')} }`;
}

// The mock has no HttpService, so the JSON arguments become a Lua table literal.
// Scenes extend the shared world for one run, so the base audit expectations stay put.
const SCENES = {
  // Invisible regions fill the deck's bottom slab ahead of the thin post, so a capped bounds query would lose the post.
  narrowSupport: String.raw`
part("Deck", world, { -200, 20, -200 }, { 20, 1, 20 })
for i = 1, 70 do
	part("Region" .. i, world, { -209 + (i % 10) * 2, 19.5, -209 + math.floor(i / 10) * 2 }, { 1, 0.5, 1 }, { Transparency = 1, CanCollide = false })
end
part("Post", world, { -194, 9.75, -197 }, { 1, 19.5, 1 })
`,
  nested: String.raw`
local shed = make("Model", "Shed", world)
part("Floor", shed, { -100, 0.5, -100 }, { 10, 1, 10 })
part("Wall", shed, { -96, 3, -100 }, { 1, 4, 10 })
part("Table", make("Model", "Kitchen", shed), { -98, 2, -100 }, { 2, 2, 2 })
part("Cutter", world, { -97, 2.5, -100 }, { 2, 1, 1 })
local hut = make("Model", "Hut", world)
part("Base", hut, { -150, 20, -150 }, { 10, 1, 10 })
part("Door", hut, { -150, 23, -155.5 }, { 4, 5, 0.4 }, { Anchored = false })
`,
  storage: String.raw`
local level = make("Folder", "Level", make("ReplicatedStorage", "ReplicatedStorage", game))
part("Floor", level, { 0, 0.5, 0 }, { 50, 1, 50 })
part("Seat", make("Model", "Chair", level), { 0, 2, 0 }, { 2, 1, 2 })
`,
};

function runInMockWorld(name: string, code: string, scene = '') {
  const inlined = code.replace(
    /^local ARGS = game:GetService\("HttpService"\):JSONDecode\(\[(=*)\[\n([\s\S]*?)\]\1\]\)/,
    (_match, _level, json: string) => `local ARGS = ${luaLiteral(JSON.parse(json))}`,
  );
  expect(inlined).not.toContain('HttpService');
  const file = scratch(name, `${MOCK_WORLD}\n${scene}\nlocal result = (function()\n${inlined}\nend)()\nprint(encode(result))\n`);
  const run = spawnSync(interpreter!, [file], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`${name} failed: ${run.stderr}${run.stdout}`);
  return JSON.parse(run.stdout.trim().split('\n').pop()!);
}

(interpreter ? describe : describe.skip)('spatial_check Luau in a mock world', () => {
  test('the harness refuses tables the plugin would encode differently', () => {
    expect(() => runInMockWorld('mixed', 'return { 1, 2, extra = 3 }')).toThrow(/mixed or sparse/);
    expect(() => runInMockWorld('sparse', 'return { [2] = "x" }')).toThrow(/mixed or sparse|non-string key/);
    expect(() => runInMockWorld('infinite', 'return { gap = math.huge }')).toThrow(/non-finite/);
  });

  test('parts of one Humanoid rig are not buried in each other, while other parts still are', () => {
    const scene = String.raw`
local rig = make("Model", "Dummy", world)
make("Humanoid", "Humanoid", rig)
part("HumanoidRootPart", rig, { -100, 1, -100 }, { 2, 2, 1 }, { Transparency = 1 })
part("Torso", rig, { -100, 1, -100 }, { 2, 2, 1 })
part("Stuck", world, { -100, -0.5, -100 }, { 0.5, 0.5, 0.5 })
`;
    const result = runInMockWorld('rig', auditOf({ paths: ['game.Workspace.Dummy', 'game.Workspace.Stuck'] }), scene);
    expect(result.buried).toEqual([{ part: 'game.Workspace.Stuck', inside: 'game.Workspace.Baseplate', volume: 0.125 }]);
  });

  test('audit finds floating, falling, overlapping, buried, tiny and far objects', () => {
    const result = runInMockWorld('audit', SNIPPETS.audit);
    expect(result.root).toBe('game.Workspace');
    expect(result.counts).toEqual({ floating: 6, overlaps: 3, buried: 1, falling: 2, tiny: 1, outside: 1 });
    expect(result.scanned).toMatchObject({ objects: 21, parts: 22, queried: 20 });

    expect(result.floating[0]).toEqual({ path: 'game.Workspace.Faraway', bottom: 0 });
    const gaps = Object.fromEntries(result.floating.map((row: { path: string; gap?: number }) => [row.path, row.gap]));
    // Rays pass through the invisible trigger under Floater, the rotated ramp does not reach under Coin, Gem on P1 does not hold P1 up, and neither does Prop sunk into Sky.
    expect(gaps).toEqual({
      'game.Workspace.Faraway': undefined,
      'game.Workspace.Sky': 49.5,
      'game.Workspace.Floater': 9.5,
      'game.Workspace.P1': 9.5,
      'game.Workspace.P2': 9.5,
      'game.Workspace.Coin': 2,
    });
    expect(result.floating[1]).toEqual({ path: 'game.Workspace.Sky', gap: 49.5, below: 'game.Workspace.Baseplate', bottom: 49.5 });
    expect(result.floating[5]).toMatchObject({ path: 'game.Workspace.Coin', below: 'game.Workspace.Baseplate' });

    expect(result.falling).toEqual([
      { rootPart: 'game.Workspace.Ghostly', parts: 1, reason: 'no colliding parts, falls through everything' },
      { rootPart: 'game.Workspace.Crate', parts: 1, drop: 4, below: 'game.Workspace.Baseplate' },
    ]);
    expect(result.overlaps).toEqual([
      { a: 'game.Workspace.Props.Box1', b: 'game.Workspace.Props.Box2', volume: 16, depth: 2, partPairs: 1, deepest: ['game.Workspace.Props.Box1', 'game.Workspace.Props.Box2'] },
      { a: 'game.Workspace.Big', b: 'game.Workspace.Small', volume: 1, depth: 1, partPairs: 1, deepest: ['game.Workspace.Big', 'game.Workspace.Small'] },
      { a: 'game.Workspace.Sky', b: 'game.Workspace.Prop', volume: 0.8, depth: 0.2, partPairs: 1, deepest: ['game.Workspace.Sky', 'game.Workspace.Prop'] },
    ]);
    expect(result.buried).toEqual([{ part: 'game.Workspace.Small', inside: 'game.Workspace.Big', volume: 1 }]);
    expect(result.tiny).toEqual([{ path: 'game.Workspace.Speck', size: [0.05, 0.05, 0.05] }]);
    expect(result.outside).toEqual([{ path: 'game.Workspace.Faraway', center: [5000, 0.5, 0], distance: 4894 }]);
    expect(result.extent).toEqual({ min: [-60, -0.5, -60], max: [106, 50, 100] });
  });

  test('audit with paths checks only those objects and reports missing ones', () => {
    const result = runInMockWorld('auditPaths', SNIPPETS.auditPaths);
    expect(result.missing).toEqual(['game.Workspace.Missing']);
    expect(result.scanned).toMatchObject({ objects: 1, parts: 1 });
    expect(result.floating).toEqual([{ path: 'game.Workspace.Coin', gap: 2, below: 'game.Workspace.Baseplate', bottom: 2 }]);
  });

  test('a support beside crowded invisible regions still holds a deck up', () => {
    const result = runInMockWorld('narrowSupport', auditOf({ paths: ['game.Workspace.Deck'] }), SCENES.narrowSupport);
    expect(result.scanned).toMatchObject({ objects: 1, parts: 1 });
    expect(result.counts.floating).toBe(0);
  });

  test('anchored parts float on their own and unscanned hits group like a full audit', () => {
    const full = runInMockWorld('nested', SNIPPETS.audit, SCENES.nested);
    expect(full.floating).toContainEqual({ path: 'game.Workspace.Hut', gap: 19.5, below: 'game.Workspace.Baseplate', bottom: 19.5 });
    expect(full.falling).toContainEqual({ rootPart: 'game.Workspace.Hut.Door', parts: 1, drop: 20.5, below: 'game.Workspace.Baseplate' });
    const floatingPaths = full.floating.map((row: { path: string }) => row.path);
    expect(floatingPaths).not.toContain('game.Workspace.Shed');
    expect(floatingPaths).not.toContain('game.Workspace.Cutter');

    type Pair = { a: string; b: string; volume: number; partPairs: number };
    const cutterRows = (rows: Pair[]) => rows
      .filter((row) => row.a === 'game.Workspace.Cutter' || row.b === 'game.Workspace.Cutter')
      .map((row) => ({ pair: [row.a, row.b].sort(), volume: row.volume, partPairs: row.partPairs }));
    const expected = [{ pair: ['game.Workspace.Cutter', 'game.Workspace.Shed'], volume: 1.5, partPairs: 2 }];
    expect(cutterRows(full.overlaps)).toEqual(expected);
    const only = runInMockWorld('nestedPaths', auditOf({ paths: ['game.Workspace.Cutter'] }), SCENES.nested);
    expect(cutterRows(only.overlaps)).toEqual(expected);
  });

  test('audits stay inside Workspace, where spatial queries look', () => {
    const base = runInMockWorld('audit', SNIPPETS.audit, SCENES.storage);
    const game = runInMockWorld('auditGame', SNIPPETS.auditGame, SCENES.storage);
    expect(game.root).toBe('game.Workspace');
    expect(game.scanned).toEqual(base.scanned);
    expect(game.counts).toEqual(base.counts);
    expect(runInMockWorld('auditStorage', SNIPPETS.auditStorage, SCENES.storage).error)
      .toBe('game.ReplicatedStorage.Level is not in Workspace, and spatial queries only see Workspace');
    const mixed = runInMockWorld('auditMixed', auditOf({ paths: ['game.ReplicatedStorage.Level.Chair', 'game.Workspace.Coin'] }), SCENES.storage);
    expect(mixed.notInWorkspace).toEqual(['game.ReplicatedStorage.Level.Chair']);
    expect(mixed.scanned).toMatchObject({ objects: 1, parts: 1 });
  });

  test('bounds feed the jump math with StarterPlayer stats', () => {
    const result = runInMockWorld('gaps', SNIPPETS.gaps);
    expect(result.boxes[0]).toEqual({ path: 'game.Workspace.P1', min: [-2, 9.5, 98], max: [2, 10.5, 102], extents: [4, 1, 4] });
    expect(result.character).toEqual({ gravity: 196.2, source: 'StarterPlayer', walkSpeed: 16, useJumpPower: false, jumpPower: 50, jumpHeight: 7.2 });
    const [jump] = analyzeJumps(result.boxes, jumpStats(result.character));
    expect(jump).toMatchObject({ gap: 8, rise: 0, jumpable: true });
  });

  test('measure reports clearance through invisible triggers', () => {
    const result = runInMockWorld('measure', SNIPPETS.measure);
    expect(result.boxes[0]).toMatchObject({ path: 'game.Workspace.Props.Box1', clearance: 0 });
    expect(result.boxes[1]).toEqual({ min: [0, 50, 0], max: [0, 50, 0], extents: [0, 0, 0], clearance: 39.5, below: 'game.Workspace.Floater' });
  });

  test('reach stands on a part top and sums the waypoints', () => {
    const result = runInMockWorld('reach', SNIPPETS.reach);
    expect(result).toMatchObject({
      from: 'game.Workspace.P1', start: [0, 13.5, 100], goal: [12, 13, 100], status: 'Success',
      waypoints: 3, jumps: 1, jumpAt: [[6, 17.25, 100]], finishToGoal: 0,
      agent: { radius: 2, height: 5, canJump: true, source: 'StarterPlayer' },
    });
    expect(result.length).toBeCloseTo(Math.hypot(6, 3.75) + Math.hypot(6, 4.25), 2);
    expect(result.ascent).toBe(3.75);
    expect(result.to).toBeUndefined();
  });
});
