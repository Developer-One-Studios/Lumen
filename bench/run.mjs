#!/usr/bin/env node
// Runs the same Studio tasks twice, once with only tools robloxstudio-mcp 3.2.0 already had and once with
// Lumen's dedicated tools, and reports tool calls, Studio time, data returned and what the agent has to write.
// It needs Studio open on an unsaved place with the Lumen plugin connected, because it builds fixtures
// named LumenBench* there and removes them afterwards.
//
// Usage: node bench/run.mjs [server entry] [output folder]
// Environment: LUMEN_BENCH_RUNS (default 1), LUMEN_BENCH_TURN_S (seconds an agent turn costs before it writes
// anything, default 5), LUMEN_BENCH_TOKENS_S (tokens the agent writes per second, default 50),
// LUMEN_BENCH_ONLY (comma separated scenario ids).
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = process.argv[2] ?? join(here, '..', 'packages', 'lumen-mcp', 'dist', 'index.js');
const outDir = process.argv[3] ?? process.env.LUMEN_BENCH_OUT ?? join(here, 'results');
const runs = Math.max(1, Number(process.env.LUMEN_BENCH_RUNS ?? 1));
const turnSeconds = Number(process.env.LUMEN_BENCH_TURN_S ?? 5);
const tokensPerSecond = Number(process.env.LUMEN_BENCH_TOKENS_S ?? 50);
const only = process.env.LUMEN_BENCH_ONLY ? new Set(process.env.LUMEN_BENCH_ONLY.split(',')) : undefined;

// A minimal MCP client over stdio. A second server joins a running one in proxy mode.
const server = spawn(process.execPath, [serverEntry], { stdio: ['pipe', 'pipe', 'pipe'] });
server.stderr.on('data', () => {});
const pending = new Map();
let buffer = '';
server.stdout.on('data', (chunk) => {
  buffer += chunk;
  for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  }
});
let nextId = 1;
function request(method, params) {
  const id = nextId++;
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolve) => pending.set(id, resolve));
}

async function call(name, args) {
  const started = performance.now();
  const reply = await request('tools/call', { name, arguments: args });
  const ms = performance.now() - started;
  const content = reply.result?.content ?? [];
  const text = content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
  const images = content.filter((block) => block.type === 'image').length;
  return { ms, text: reply.error ? JSON.stringify(reply.error) : text, images, isError: Boolean(reply.result?.isError || reply.error) };
}

function json(text) {
  try {
    const value = JSON.parse(text);
    return typeof value?.returnValue === 'string' ? JSON.parse(value.returnValue) : value;
  } catch {
    return undefined;
  }
}

// Everything an arm costs: each call is one agent turn, and its arguments, code included, are what the agent writes.
function newArm() {
  return { calls: 0, ms: 0, bytes: 0, images: 0, written: 0, errors: [] };
}
async function use(arm, name, args) {
  const result = await call(name, args);
  arm.calls += 1;
  arm.ms += result.ms;
  arm.bytes += result.text.length;
  arm.images += result.images;
  arm.written += JSON.stringify(args).length;
  if (result.isError) arm.errors.push(`${name}: ${result.text.slice(0, 200)}`);
  return result;
}
const luau = (arm, code, target = 'edit') => use(arm, 'execute_luau', { code, target, timeout_s: 60 });
// Setup and checks are the harness's own work, so they are not counted.
const quiet = (code, target = 'edit') => call('execute_luau', { code, target, timeout_s: 60 });

const LAG_FIXTURE = `
local model = Instance.new("Model") model.Name = "LumenBenchLag"
for i = 1, 12 do
	local p = Instance.new("Part") p.Anchored = true p.Position = Vector3.new(200 + i * 4, 3, 200)
	local e = Instance.new("ParticleEmitter") e.Rate = 400 e.Size = NumberSequence.new(3) e.Parent = p
	p.Parent = model
end
for i = 1, 6 do
	local p = Instance.new("Part") p.Anchored = true p.Position = Vector3.new(200 + i * 8, 6, 210)
	local l = Instance.new("PointLight") l.Shadows = true l.Range = 40 l.Parent = p
	p.Parent = model
end
model.Parent = workspace
local calm = Instance.new("Model") calm.Name = "LumenBenchCalm"
for i = 1, 30 do local p = Instance.new("Part") p.Anchored = true p.Position = Vector3.new(i * 3, 3, 260) p.Parent = calm end
calm.Parent = workspace
return true`;

const ARENA_FIXTURE = `
local arena = Instance.new("Folder") arena.Name = "LumenBenchArena"
for i = 1, 20 do
	local p = Instance.new("Part") p.Name = "Block" .. i p.Anchored = true p.Position = Vector3.new(i * 4, 3, -200) p.Parent = arena
end
arena.Parent = workspace
return true`;

const EXPERIMENT = `
local arena = workspace.LumenBenchArena
for i = 1, 5 do arena["Block" .. i].Position += Vector3.new(0, 10, 0) end
arena.Block6:Destroy() arena.Block7:Destroy()
for i = 1, 3 do local p = Instance.new("Part") p.Name = "Extra" .. i p.Anchored = true p.Parent = arena end
game.Lighting.ClockTime = 3
return true`;

const OBBY_FIXTURE = `
local obby = Instance.new("Folder") obby.Name = "LumenBenchObby"
local function part(name, size, pos)
	local p = Instance.new("Part") p.Name = name p.Anchored = true p.Size = size p.Position = pos p.Parent = obby
end
part("P1", Vector3.new(6, 1, 6), Vector3.new(0, 5, -300))
part("P2", Vector3.new(6, 1, 6), Vector3.new(14, 5, -300))
part("P3", Vector3.new(6, 1, 6), Vector3.new(40, 5, -300))
part("LumenBenchFloat", Vector3.new(4, 1, 4), Vector3.new(60, 30, -300))
part("Buried", Vector3.new(1, 0.5, 1), Vector3.new(0, 5, -300))
obby.Parent = workspace
return true`;

const GUI_FIXTURE = `
local gui = Instance.new("ScreenGui") gui.Name = "LumenBenchGui"
local function button(name, pos, size, textSize)
	local b = Instance.new("TextButton") b.Name = name b.Position = pos b.Size = size b.Text = name b.TextSize = textSize b.Parent = gui
end
button("Play", UDim2.new(1, -40, 0.5, 0), UDim2.fromOffset(120, 40), 18)
button("Tiny", UDim2.fromOffset(20, 20), UDim2.fromOffset(60, 20), 7)
button("Fine", UDim2.fromOffset(20, 60), UDim2.fromOffset(160, 50), 18)
gui.Parent = game.StarterGui
return true`;

const LEAKY_MODULE = `local held = {}
local M = {}
function M.cycle()
	local enemy = Instance.new("Model")
	enemy.Name = "LumenBenchEnemy"
	Instance.new("Part", enemy)
	enemy.Parent = workspace
	enemy:Destroy()
	table.insert(held, enemy)
	for _ = 1, 300 do table.insert(held, Instance.new("Folder")) end
end
return M`;

const NOISY_LOG = `
for i = 1, 20 do warn("LumenBench warning: ammo was nil for slot " .. i) end
for _ = 1, 15 do task.spawn(error, "LumenBench error: missing config Weapons.Sword") end
task.wait(0.3)
return true`;

// Each arm reads a fresh batch, and get_errors first moves past whatever the previous arm left.
async function logNoise() {
  await call('get_errors', { level: 'both' });
  await quiet(NOISY_LOG);
}

const cleanup = (clockTime) => `
for _, root in { workspace, game.ServerStorage, game.StarterGui } do
	for _, child in root:GetChildren() do
		if string.sub(child.Name, 1, 10) == "LumenBench" then child:Destroy() end
	end
end
game.Lighting.ClockTime = ${clockTime}
return true`;

// Read before any fixture is built, so the checkpoint task and the cleanup put back the place's own value.
let clockTime = 14;

const scenarios = [
  {
    id: 'lag',
    title: 'Find what makes a scene expensive',
    setup: () => quiet(LAG_FIXTURE),
    async baseline(arm) {
      const result = await luau(arm, `
local frames, start = 0, os.clock()
local conn = game:GetService("RunService").Heartbeat:Connect(function() frames += 1 end)
task.wait(1.5)
conn:Disconnect()
local stats = { fps = frames / (os.clock() - start), memoryMb = game:GetService("Stats"):GetTotalMemoryUsageMb() }
local rows = {}
for _, top in workspace:GetChildren() do
	local particles, rate, shadows, parts = 0, 0, 0, 0
	for _, d in top:GetDescendants() do
		if d:IsA("ParticleEmitter") and d.Enabled then particles += 1 rate += d.Rate
		elseif d:IsA("Light") and d.Enabled and d.Shadows then shadows += 1
		elseif d:IsA("BasePart") then parts += 1 end
	end
	if particles + shadows > 0 then table.insert(rows, { name = top.Name, particles = particles, rate = rate, shadowLights = shadows, parts = parts }) end
end
table.sort(rows, function(a, b) return a.rate + a.shadowLights * 100 > b.rate + b.shadowLights * 100 end)
return { stats = stats, costly = rows }`);
      return result.text.includes('LumenBenchLag');
    },
    async lumen(arm) {
      await use(arm, 'perf_stats', { target: 'edit', duration_ms: 1500 });
      const audit = await use(arm, 'lag_audit', { root: 'game.Workspace', top: 5 });
      return audit.text.includes('LumenBenchLag');
    },
  },
  {
    id: 'checkpoint',
    title: 'Try an edit, list what changed, undo it',
    setup: () => quiet(ARENA_FIXTURE),
    async baseline(arm) {
      await luau(arm, `
local backup = workspace.LumenBenchArena:Clone()
backup.Name = "LumenBenchBackup"
backup:SetAttribute("ClockTime", game.Lighting.ClockTime)
backup.Parent = game.ServerStorage
return true`);
      await luau(arm, EXPERIMENT);
      await luau(arm, `
local live, backup = workspace.LumenBenchArena, game.ServerStorage.LumenBenchBackup
local changes = { moved = {}, removed = {}, added = {} }
for _, old in backup:GetChildren() do
	local now = live:FindFirstChild(old.Name)
	if now == nil then table.insert(changes.removed, old.Name)
	elseif (now.Position - old.Position).Magnitude > 0.01 then table.insert(changes.moved, old.Name) end
end
for _, now in live:GetChildren() do
	if backup:FindFirstChild(now.Name) == nil then table.insert(changes.added, now.Name) end
end
if game.Lighting.ClockTime ~= backup:GetAttribute("ClockTime") then changes.clockTime = game.Lighting.ClockTime end
return changes`);
      await luau(arm, `
local backup = game.ServerStorage.LumenBenchBackup
workspace.LumenBenchArena:Destroy()
game.Lighting.ClockTime = backup:GetAttribute("ClockTime")
backup:SetAttribute("ClockTime", nil)
backup.Name = "LumenBenchArena"
backup.Parent = workspace
return true`);
      return restored();
    },
    async lumen(arm) {
      await use(arm, 'checkpoint', { action: 'create', id: 'lumenbench', roots: ['game.Workspace', 'game.Lighting'] });
      await luau(arm, EXPERIMENT);
      await use(arm, 'checkpoint', { action: 'changes', id: 'lumenbench' });
      await use(arm, 'checkpoint', { action: 'revert', id: 'lumenbench' });
      await call('checkpoint', { action: 'drop', id: 'lumenbench' });
      return restored();
    },
    reset: async () => {
      await quiet(`local a = workspace:FindFirstChild("LumenBenchArena") if a then a:Destroy() end game.Lighting.ClockTime = ${clockTime} return true`);
      await quiet(ARENA_FIXTURE);
    },
  },
  {
    id: 'level',
    title: 'Find floating parts and impossible jumps',
    setup: () => quiet(OBBY_FIXTURE),
    async baseline(arm) {
      const result = await luau(arm, `
local obby = workspace.LumenBenchObby
local params = RaycastParams.new()
params.FilterType = Enum.RaycastFilterType.Exclude
local floating = {}
for _, p in obby:GetChildren() do
	params.FilterDescendantsInstances = { p }
	local bottom = p.Position - Vector3.new(0, p.Size.Y / 2, 0)
	local hit = workspace:Raycast(bottom, Vector3.new(0, -500, 0), params)
	local gap = if hit then bottom.Y - hit.Position.Y else math.huge
	if gap > 0.1 then table.insert(floating, { name = p.Name, gap = gap }) end
end
local sp = game.StarterPlayer
local g = workspace.Gravity
local jumpHeight = if sp.CharacterUseJumpPower then (sp.CharacterJumpPower ^ 2) / (2 * g) else sp.CharacterJumpHeight
local v = math.sqrt(2 * g * jumpHeight)
local reach = sp.CharacterWalkSpeed * (2 * v / g)
local jumps = {}
local order = { obby.P1, obby.P2, obby.P3 }
for i = 1, #order - 1 do
	local a, b = order[i], order[i + 1]
	local gap = (b.Position.X - b.Size.X / 2) - (a.Position.X + a.Size.X / 2)
	table.insert(jumps, { from = a.Name, to = b.Name, gap = gap, reach = reach, possible = gap <= reach })
end
return { floating = floating, jumps = jumps }`);
      const value = json(result.text);
      return Boolean(value?.jumps?.some((jump) => jump.to === 'P3' && jump.possible === false)
        && value?.floating?.some((row) => row.name === 'LumenBenchFloat'));
    },
    async lumen(arm) {
      const audit = await use(arm, 'spatial_check', { mode: 'audit', root: 'game.Workspace.LumenBenchObby' });
      const gaps = await use(arm, 'spatial_check', { mode: 'gaps', platforms: ['game.Workspace.LumenBenchObby.P1', 'game.Workspace.LumenBenchObby.P2', 'game.Workspace.LumenBenchObby.P3'] });
      const jumps = json(gaps.text)?.jumps ?? [];
      return audit.text.includes('LumenBenchFloat') && jumps.some((jump) => String(jump.to).endsWith('P3') && jump.jumpable === false);
    },
  },
  {
    id: 'ui',
    title: 'Check a menu on a phone, a tablet and a PC',
    setup: () => quiet(GUI_FIXTURE),
    async baseline(arm) {
      let found = false;
      for (const device of ['iphone_14', 'ipad_8th_generation', 'hd_1080']) {
        await use(arm, 'set_device_simulator', { deviceId: device });
        const result = await luau(arm, `
task.wait(0.5)
local viewport = workspace.CurrentCamera.ViewportSize
local issues = {}
for _, o in game.StarterGui.LumenBenchGui:GetDescendants() do
	if o:IsA("GuiObject") then
		local p, s = o.AbsolutePosition, o.AbsoluteSize
		if p.X < 0 or p.Y < 0 or p.X + s.X > viewport.X or p.Y + s.Y > viewport.Y then table.insert(issues, o.Name .. " offscreen") end
		if o:IsA("TextButton") and o.TextSize < 9 then table.insert(issues, o.Name .. " small text") end
		if o:IsA("GuiButton") and (s.X < 44 or s.Y < 44) then table.insert(issues, o.Name .. " small touch target") end
	end
end
return { viewport = { viewport.X, viewport.Y }, issues = issues }`);
        found ||= result.text.includes('Play offscreen');
      }
      await use(arm, 'set_device_simulator', { stopSimulation: true });
      return found;
    },
    async lumen(arm) {
      const result = await use(arm, 'ui_audit', { devices: ['iphone_14', 'ipad_8th_generation', 'hd_1080'], root: 'game.StarterGui.LumenBenchGui' });
      return result.text.includes('LumenBenchGui.Play') && result.text.includes('offscreen');
    },
  },
  {
    id: 'errors',
    title: 'Summarize errors and warnings',
    setup: logNoise,
    reset: logNoise,
    async baseline(arm) {
      const result = await use(arm, 'get_runtime_logs', { tail: 100 });
      return result.text.includes('LumenBench error');
    },
    async lumen(arm) {
      const result = await use(arm, 'get_errors', { level: 'both' });
      return result.text.includes('LumenBench error');
    },
  },
  {
    id: 'leak',
    title: 'Check whether spawning enemies leaks memory',
    playtest: true,
    setup: async () => {
      await quiet(`local m = Instance.new("ModuleScript") m.Name = "LumenBenchLeaky" m.Source = ${JSON.stringify(LEAKY_MODULE)} m.Parent = game.ServerStorage return true`);
      await call('solo_playtest', { action: 'start', mode: 'play' });
    },
    async baseline(arm) {
      const result = await use(arm, 'eval_server_runtime', { timeout_s: 60, code: `
local Stats = game:GetService("Stats")
local function snapshot()
	return {
		instances = Stats.InstanceCount,
		instancesMb = Stats:GetMemoryUsageMbForTag(Enum.DeveloperMemoryTag.Instances),
		totalMb = Stats:GetTotalMemoryUsageMb(),
	}
end
local leaky = require(game.ServerStorage.LumenBenchLeaky)
leaky.cycle()
task.wait(0.2)
local before = snapshot()
for _ = 1, 5 do leaky.cycle() task.wait(0.2) end
local after = snapshot()
return { before = before, after = after, instanceGrowth = after.instances - before.instances }` });
      const value = json(result.text);
      const inner = typeof value?.result === 'string' ? json(value.result) ?? value : value;
      return Number(inner?.instanceGrowth ?? 0) > 0;
    },
    async lumen(arm) {
      const result = await use(arm, 'leak_check', { action: 'require(game.ServerStorage.LumenBenchLeaky).cycle()', iterations: 6, settle_ms: 200, target: 'server' });
      const growing = json(result.text)?.growing ?? [];
      return growing.some((row) => row.metric === 'instanceCount' || row.metric === 'unparentedInstances');
    },
    teardown: () => call('solo_playtest', { action: 'stop' }),
  },
  {
    id: 'playtest',
    title: 'Playtest: jump, check it, screenshot, collect errors',
    async baseline(arm) {
      await use(arm, 'solo_playtest', { action: 'start', mode: 'play' });
      await luau(arm, `
local player = game.Players.LocalPlayer
local deadline = os.clock() + 15
while os.clock() < deadline and not (player.Character and player.Character:FindFirstChild("HumanoidRootPart")) do task.wait(0.1) end
return player.Character ~= nil`, 'client-1');
      await use(arm, 'simulate_keyboard_input', { keyCode: 'Space', action: 'tap', duration: 0.2, target: 'client-1' });
      const sample = await luau(arm, `
local hrp = game.Players.LocalPlayer.Character.HumanoidRootPart
local ys = {}
for _ = 1, 8 do table.insert(ys, hrp.Position.Y) task.wait(0.1) end
return ys`, 'client-1');
      await use(arm, 'capture_screenshot', {});
      await use(arm, 'get_runtime_logs', { tail: 50 });
      await use(arm, 'solo_playtest', { action: 'stop' });
      const ys = json(sample.text) ?? [];
      return Array.isArray(ys) && Math.max(...ys) - Math.min(...ys) > 1;
    },
    async lumen(arm) {
      const result = await use(arm, 'playtest_scenario', {
        start: 'play',
        steps: [
          { key: 'Space', hold_s: 0.2 },
          { watch: { y: 'game.Players.LocalPlayer.Character.HumanoidRootPart.Position.Y' }, duration_ms: 800, interval_ms: 100, peer: 'client-1' },
          { screenshot: 'after jump' },
        ],
      });
      const report = json(result.text);
      const y = report?.steps?.find((step) => step.kind === 'watch')?.value?.summary?.y;
      return Boolean(y && y.max - y.min > 1);
    },
  },
];

async function restored() {
  const state = json((await quiet(`
local arena = workspace:FindFirstChild("LumenBenchArena")
if not arena then return { ok = false } end
local ok = #arena:GetChildren() == 20 and game.Lighting.ClockTime ~= 3
for i = 1, 20 do
	local p = arena:FindFirstChild("Block" .. i)
	if not p or (p.Position - Vector3.new(i * 4, 3, -200)).Magnitude > 0.01 then ok = false end
end
local backup = game.ServerStorage:FindFirstChild("LumenBenchBackup")
if backup then backup:Destroy() end
return { ok = ok }`)).text);
  return state?.ok === true;
}

function average(arms) {
  const total = arms.reduce((sum, arm) => {
    for (const key of ['calls', 'ms', 'bytes', 'images', 'written']) sum[key] += arm[key];
    return sum;
  }, newArm());
  for (const key of ['calls', 'ms', 'bytes', 'images', 'written']) total[key] /= arms.length;
  total.errors = arms.flatMap((arm) => arm.errors);
  return total;
}

// About four characters per token, the usual rate for code and JSON.
const agentSeconds = (arm) => arm.calls * turnSeconds + arm.written / 4 / tokensPerSecond + arm.ms / 1000;
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
const seconds = (value) => `${value.toFixed(1)} s`;

async function main() {
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'lumen-bench', version: '1' } });
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const connected = json((await call('get_connected_instances', {})).text);
  if (!connected?.instances?.length) throw new Error('No Studio is connected. Open a place with the Lumen plugin first.');
  clockTime = Number(json((await quiet('return game.Lighting.ClockTime')).text) ?? 14);

  const results = [];
  try {
    for (const scenario of scenarios.filter((entry) => !only || only.has(entry.id))) {
      process.stderr.write(`${scenario.id}: `);
      await scenario.setup?.();
      const baseline = [];
      const lumen = [];
      let baselineFound = true;
      let lumenFound = true;
      for (let run = 0; run < runs; run++) {
        const b = newArm();
        baselineFound = (await scenario.baseline(b)) && baselineFound;
        baseline.push(b);
        await scenario.reset?.();
        const l = newArm();
        lumenFound = (await scenario.lumen(l)) && lumenFound;
        lumen.push(l);
        await scenario.reset?.();
        process.stderr.write('.');
      }
      await scenario.teardown?.();
      results.push({ id: scenario.id, title: scenario.title, baseline: { ...average(baseline), found: baselineFound }, lumen: { ...average(lumen), found: lumenFound } });
      process.stderr.write('\n');
    }
  } finally {
    await call('solo_playtest', { action: 'stop' });
    await call('set_device_simulator', { stopSimulation: true });
    await quiet(cleanup(clockTime));
  }

  const lines = [
    `| Task | Tool calls | Studio time | Data returned | Agent writes | Agent time | Found the problem |`,
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const row of results) {
    const b = row.baseline;
    const l = row.lumen;
    lines.push(`| ${row.title} | ${b.calls} → ${l.calls} | ${seconds(b.ms / 1000)} → ${seconds(l.ms / 1000)} | ${kb(b.bytes)} → ${kb(l.bytes)} | ${b.written} → ${l.written} chars | ${seconds(agentSeconds(b))} → ${seconds(agentSeconds(l))} | ${b.found ? 'yes' : 'no'} → ${l.found ? 'yes' : 'no'} |`);
  }
  const sum = (arm) => results.reduce((total, row) => {
    for (const key of ['calls', 'ms', 'bytes', 'written']) total[key] += row[arm][key];
    total.agent += agentSeconds(row[arm]);
    return total;
  }, { calls: 0, ms: 0, bytes: 0, written: 0, agent: 0 });
  const b = sum('baseline');
  const l = sum('lumen');
  lines.push(`| **All tasks** | **${b.calls} → ${l.calls}** | **${seconds(b.ms / 1000)} → ${seconds(l.ms / 1000)}** | **${kb(b.bytes)} → ${kb(l.bytes)}** | **${b.written} → ${l.written} chars** | **${seconds(b.agent)} → ${seconds(l.agent)}** | |`);
  lines.push('', `Agent time is ${turnSeconds} s per tool call, plus what the agent writes at ${tokensPerSecond} tokens per second and 4 characters per token, plus Studio time. ${runs} run${runs === 1 ? '' : 's'} per task.`);
  const table = lines.join('\n');

  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(join(outDir, `bench-${stamp}.json`), JSON.stringify({ date: new Date().toISOString(), runs, turnSeconds, tokensPerSecond, results }, null, 2));
  writeFileSync(join(outDir, `bench-${stamp}.md`), `${table}\n`);
  console.log(table);
  for (const row of results) {
    for (const [arm, data] of [['baseline', row.baseline], ['lumen', row.lumen]]) {
      for (const error of data.errors) console.error(`${row.id} ${arm}: ${error}`);
    }
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => {
    server.stdin.end();
    server.kill();
  });
