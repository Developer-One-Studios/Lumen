import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { RobloxStudioTools } from '../tools/index.js';
import { luauLongString } from '../tools/fork-luau.js';
import { ForkTools, type ForkHost, type PeerTarget } from '../tools/fork-tools.js';
import {
  parseSteps,
  playtestFeature,
  shapeSamples,
  waitForCondition,
  waitForLog,
  watchValues,
} from '../tools/fork/playtest.js';
import {
  conditionLuau,
  explainLuauError,
  frameClockLuau,
  isBody,
  runLuau,
  userFunction,
  watchLuau,
} from '../tools/fork/playtest-luau.js';

type Call = { endpoint: string; data: Record<string, unknown>; code: string; peerId: string; timeoutMs?: number };
type LogEntry = { seq: number; ts: number; level: string; message: string };

const text = (body: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(body) }] });
const ok = (value: unknown) => ({ success: true, returnValue: JSON.stringify(value) });
const json = (result: { content: Array<{ text?: string }> }) => JSON.parse(result.content[0].text!);

const compiler = spawnSync('luau-compile', ['--help']).error ? undefined : 'luau-compile';
const runtime = spawnSync('luau', ['--help']).error ? undefined : 'luau';
// Every snippet a test sends to a fake peer is compiled at the end, so generated code paths are covered too.
const sentCode = new Set<string>();

function tempFile(name: string, code: string): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fork-playtest-')), `${name}.luau`);
  fs.writeFileSync(file, code);
  return file;
}

function compile(name: string, code: string) {
  return spawnSync(compiler!, ['--null', tempFile(name, code)], { encoding: 'utf8' });
}

function argsOf(code: string): Record<string, unknown> {
  return JSON.parse(/JSONDecode\(\[=*\[\n(.*?)\]=*\]\)/s.exec(code)![1]);
}

/** A Luau table constructor for JSON-shaped data, standing in for HttpService:JSONDecode. */
function luauLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'nil';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return `{ ${value.map(luauLiteral).join(', ')} }`;
  return `{ ${Object.entries(value).map(([key, item]) => `[${JSON.stringify(key)}] = ${luauLiteral(item)}`).join(', ')} }`;
}

/**
 * Runs a generated chunk as the plugin does (loadstring of a wrapper function, so pcall messages carry wrapper lines)
 * on a virtual clock, with task stand-ins and an encoder that rejects what JSONEncode rejects.
 */
function runInLuau(code: string): string {
  const wrapped = `return ((function()\nlocal __mcp_pad = 0\nlocal function __mcp_run()\n${code}\nend\nreturn __mcp_run()\nend)())`;
  const harness = String.raw`
local now = 0
local sleeping = {}
os = { clock = function() return now end }
task = {}
function task.wait(seconds)
	table.insert(sleeping, { thread = coroutine.running(), wake = now + math.max(seconds or 0, 1 / 60) })
	coroutine.yield()
end
function task.spawn(fn, ...)
	local thread = coroutine.create(fn)
	local ok, err = coroutine.resume(thread, ...)
	if not ok then error(err, 0) end
	return thread
end
function task.cancel(thread)
	for i = #sleeping, 1, -1 do
		if sleeping[i].thread == thread then table.remove(sleeping, i) end
	end
	coroutine.close(thread)
end
local args = ${luauLiteral(argsOf(code))}
game = { GetService = function() return { JSONDecode = function() return args end } end }

local function encode(value)
	local kind = type(value)
	if kind == "nil" then return "null" end
	if kind == "boolean" then return tostring(value) end
	if kind == "number" then
		assert(value == value and value ~= math.huge and value ~= -math.huge, "JSONEncode rejects a non-finite number")
		return string.format("%.14g", value)
	end
	if kind == "string" then
		assert(utf8.len(value) ~= nil, "JSONEncode rejects invalid UTF-8")
		return '"' .. string.gsub(value, '[%c"\\]', function(c) return string.format("\\u%04x", string.byte(c)) end) .. '"'
	end
	assert(kind == "table", "JSONEncode rejects a " .. kind)
	if next(value) == nil then return "[]" end
	local parts = {}
	if #value > 0 then
		for i = 1, #value do parts[i] = encode(value[i]) end
		return "[" .. table.concat(parts, ",") .. "]"
	end
	for key, item in pairs(value) do table.insert(parts, encode(tostring(key)) .. ":" .. encode(item)) end
	return "{" .. table.concat(parts, ",") .. "}"
end

local source = ${luauLongString(wrapped)}
local main = coroutine.create(function() return assert(loadstring(source))() end)
local finished, result = false, nil
local function resume(thread)
	local ok, value = coroutine.resume(thread)
	if not ok then error(value, 0) end
	if thread == main and coroutine.status(main) == "dead" then finished, result = true, value end
end
resume(main)
while not finished do
	table.sort(sleeping, function(a, b) return a.wake < b.wake end)
	local nextUp = assert(table.remove(sleeping, 1), "every thread is blocked")
	now = math.max(now, nextUp.wake)
	resume(nextUp.thread)
end
print(encode(result))
`;
  const result = spawnSync(runtime!, [tempFile('harness', harness)], { encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) throw new Error(`luau failed: ${result.stderr}${result.stdout}`);
  return result.stdout.trim().split('\n').pop()!;
}

/** A Studio scope whose runtime log buffers behave like the plugin's: seq cursors, tail, since. */
function fakeHost(roles: string[], reply: (call: Call) => unknown) {
  const peers: PeerTarget[] = roles.map((role) => ({ role, peerId: role }));
  const logs = new Map<string, LogEntry[]>();
  let seq = 0;
  const calls: Call[] = [];
  const logReads: string[] = [];
  const log = (peerId: string, level: string, message: string, ts = Date.now() / 1000) => {
    const buffer = logs.get(peerId) ?? [];
    buffer.push({ seq: ++seq, ts, level, message });
    logs.set(peerId, buffer);
  };
  const playtest: string[] = [];
  const host: ForkHost = {
    // Like the real router, a role that is not connected is a routing error rather than an empty list.
    peerTargets: async (target) => {
      if (target === undefined || target === 'all') return [...peers];
      const matched = peers.filter((peer) => peer.role === target);
      if (matched.length === 0) throw new Error(`target_role_not_present_on_instance: no ${target}`);
      return matched;
    },
    requestPeer: async (endpoint, data, peerId, timeoutMs) => {
      const payload = (data ?? {}) as Record<string, unknown>;
      if (endpoint === '/api/get-runtime-logs') {
        logReads.push(peerId);
        const buffer = logs.get(peerId) ?? [];
        const since = payload.since as number | undefined;
        let entries = since === undefined ? buffer : buffer.filter((entry) => entry.seq > since);
        if (payload.tail === 0) entries = [];
        return { entries, totalDropped: 0, nextSince: buffer.length > 0 ? buffer[buffer.length - 1].seq : since ?? 0 };
      }
      const call = { endpoint, data: payload, code: String(payload.code ?? ''), peerId, timeoutMs };
      calls.push(call);
      if (call.code) sentCode.add(call.code);
      return reply(call);
    },
    soloPlaytest: async (action, mode) => {
      playtest.push(mode ? `${action}:${mode}` : action);
      if (action === 'start') {
        peers.push({ role: 'server', peerId: 'server' });
        if (mode === 'play') peers.push({ role: 'client-1', peerId: 'client-1' });
      }
      if (action === 'stop') peers.splice(0, peers.length, ...peers.filter((peer) => peer.role === 'edit'));
      return text({ success: true });
    },
    getRuntimeLogs: async () => text({ entries: [] }),
  };
  return { host, calls, log, logReads, playtest, peers };
}

describe('playtest Luau', () => {
  test('return as a statement marks a body, anywhere else an expression', () => {
    expect(isBody('workspace.Door.Open.Value')).toBe(false);
    expect(isBody('workspace:FindFirstChild("returnPoint") ~= nil')).toBe(false);
    expect(isBody('label.Text == "return to lobby"')).toBe(false);
    expect(isBody('x -- return early\n')).toBe(false);
    expect(isBody('local coins = leaderstats.Coins.Value\nreturn coins >= 10')).toBe(true);
    expect(isBody('if ready then return true end return false')).toBe(true);
  });

  test('user code sits first in the chunk so errors name its own line', () => {
    const chunk = conditionLuau(userFunction('condition', 'local a = 1\nreturn a +'), { timeout_s: 1, interval_ms: 100, yield_s: 1 });
    expect(chunk.code.startsWith('local BASE = (debug.info(1, "l") or 1) - 1\nlocal USER = {}\nUSER[1] = function()\nlocal a = 1\nreturn a +\nend\n')).toBe(true);
    expect(explainLuauError('user_code:5: attempt to perform arithmetic', chunk.ranges)).toBe('condition:2: attempt to perform arithmetic');
    expect(explainLuauError('user_code:6: Expected identifier', chunk.ranges)).toBe('condition:2 (at end): Expected identifier');
    expect(explainLuauError('user_code:40: in the generated chunk', chunk.ranges)).toBe('user_code:40: in the generated chunk');
    const expression = conditionLuau(userFunction('condition', 'a.b'), { timeout_s: 1, interval_ms: 100, yield_s: 1 });
    expect(explainLuauError('user_code:4: on the return line', expression.ranges)).toBe('condition:1: on the return line');
    expect(explainLuauError('user_code:3: function header', expression.ranges)).toBe('user_code:3: function header');
  });

  (compiler ? test : test.skip)('a syntax error in an expression maps back to the caller', () => {
    const chunk = conditionLuau(userFunction('condition', 'x =='), { timeout_s: 1, interval_ms: 100, yield_s: 1 });
    const result = compile('broken', chunk.code);
    const line = /\((\d+),\d+\): SyntaxError/.exec(result.stdout + result.stderr)![1];
    expect(explainLuauError(`user_code:${line}: SyntaxError`, chunk.ranges)).toMatch(/^condition:1/);
  });

  const SNIPPETS: Record<string, string> = {
    conditionExpression: conditionLuau(userFunction('condition', 'workspace:FindFirstChild("Coin") == nil'), { timeout_s: 5, interval_ms: 100, yield_s: 5 }).code,
    conditionBody: conditionLuau(userFunction('condition', 'local p = game.Players.LocalPlayer\nreturn p and p.Character'), { timeout_s: 0, interval_ms: 16, yield_s: 5 }).code,
    run: runLuau(userFunction('run', 'local x = 1\nreturn { x = x, at = Vector3.new(1, 2, 3) }', 'body')).code,
    runNoReturn: runLuau(userFunction('run', 'print("hi")', 'body')).code,
    watch: watchLuau(
      [userFunction('speed', 'workspace.Ball.AssemblyLinearVelocity'), userFunction('cooldown', 'local m = require(game.ReplicatedStorage.Cd)\nreturn m.left')],
      userFunction('action', 'workspace.Ball:ApplyImpulse(Vector3.new(0, 100, 0))', 'body'),
      { names: ['speed', 'cooldown'], duration_ms: 1000, interval_ms: 50 },
    ).code,
    watchNoAction: watchLuau([userFunction('hp', 'game.Players.LocalPlayer.Character.Humanoid.Health')], undefined, { names: ['hp'], duration_ms: 500, interval_ms: 16 }).code,
    frameClock: frameClockLuau(userFunction('stamp', 'game.SoundService.Take.TimePosition'), { duration_ms: 3000, gap_ms: 33 }).code,
    frameClockNoStamp: frameClockLuau(undefined, { duration_ms: 3000, gap_ms: 33 }).code,
  };

  (compiler ? test.each(Object.entries(SNIPPETS)) : test.skip.each(Object.entries(SNIPPETS)))('%s compiles as Luau', (name, code) => {
    const result = compile(name, code);
    expect(result.stderr + result.stdout).not.toMatch(/error/i);
    expect(result.status).toBe(0);
  });
});

// The generated chunks run for real in the luau CLI, so yields, error lines and string cuts are checked end to end.
(runtime ? describe : describe.skip)('playtest Luau at runtime', () => {
  const luauHost = () => fakeHost(['edit'], (call) => ({ success: true, returnValue: runInLuau(call.code) }));

  test('a runtime error inside a condition body names the caller line, not the generated chunk', async () => {
    const { host } = luauHost();
    const result = await waitForCondition(host, { condition: 'local a = 1\nlocal b = nil\nreturn b.c', timeout_s: 0.5 }, undefined);
    expect(result).toMatchObject({ met: false, last_error: "condition:3: attempt to index nil with 'c'" });
    expect(result.polls).toBeGreaterThan(3);
  });

  test('a condition that yields forever is cancelled at timeout_s and reported as not met', async () => {
    const { host } = luauHost();
    const result = await waitForCondition(host, { condition: 'task.wait(1000)', timeout_s: 2 }, undefined);
    expect(result).toMatchObject({ met: false, polls: 1 });
    expect(result.last_error).toMatch(/still yielding when time ran out/);
    expect(result.elapsed_s).toBeGreaterThanOrEqual(2);
    expect(result.elapsed_s).toBeLessThan(2.1);
  });

  test('a condition that yields briefly is waited for', async () => {
    const { host } = luauHost();
    const result = await waitForCondition(host, { condition: 'local t = os.clock()\ntask.wait(0.5)\nreturn os.clock() - t', timeout_s: 2 }, undefined);
    expect(result).toMatchObject({ met: true, polls: 1 });
    expect(result.value).toBeGreaterThanOrEqual(0.5);
  });

  test('expect gives a yielding check its own allowance, and run reports whether anything was returned', async () => {
    const { host } = luauHost();
    const tools = { forkHost: host, fork: new ForkTools(host) } as unknown as RobloxStudioTools;
    const report = json(await playtestFeature.handlers.playtest_scenario(tools, {
      start: 'none',
      stop_on_failure: false,
      steps: [
        { expect: 'task.wait(1)\nreturn true' },
        { expect: 'task.wait(10)\nreturn true', timeout_s: 2 },
        { run: 'local door = 1' },
        { run: 'return nil' },
        { run: 'return "a" .. string.rep("\\u{e9}", 400)' },
        { run: 'return { ["\\255key"] = "\\255abc" }' },
      ],
    }));
    expect(report.steps.map((step: { ok: boolean }) => step.ok)).toEqual([true, false, true, true, true, true]);
    expect(report.steps[1].error).toMatch(/^errored: still yielding/);
    expect(report.steps[2]).not.toHaveProperty('value');
    expect(report.steps[3].value).toBeNull();
    // 300 characters then the cut marker, where a byte cut at 300 would have split the 150th é.
    expect(report.steps[4].value).toBe(`a${'é'.repeat(299)}...`);
    expect(report.steps[5].value).toEqual({ '?key': '?abc' });
  });

  test('watch cuts strings on character boundaries, records yielding expressions as errors and maps error lines', async () => {
    const { host } = luauHost();
    const result = await watchValues(host, {
      expressions: {
        label: '"a" .. string.rep("\\u{e9}", 200)',
        stuck: 'task.wait(1)',
        broken: 'local x = nil\nreturn x.y',
        clock: 'os.clock()',
      },
      action: 'error("boom")',
      duration_ms: 300,
      interval_ms: 100,
    }, undefined);
    expect(result.series.label[0]).toBe(`a${'é'.repeat(119)}...`);
    expect(result.series.stuck.every((value: unknown) => value === null)).toBe(true);
    expect(result.errors).toMatchObject({
      stuck: { first: 'yielded, a sampled expression must not yield' },
      broken: { first: "broken:2: attempt to index nil with 'y'" },
    });
    expect((result.errors as Record<string, { count: number }>).stuck.count).toBe(result.samples);
    expect(result.summary.clock).toMatchObject({ first: 0 });
    expect((result.summary.clock as { last: number }).last).toBeGreaterThanOrEqual(0.3);
    expect(result.action_error).toBe('action:1: boom');
  });
});

describe('wait_for', () => {
  test('polls on the server while a playtest runs, with a request timeout past timeout_s', async () => {
    const { host, calls } = fakeHost(['edit', 'server', 'client-1'], () => ok({ met: true, elapsed_s: 1.2, polls: 13, value: 3 }));
    const result = await waitForCondition(host, { condition: 'workspace.Coins.Value >= 3', timeout_s: 30 }, undefined);
    expect(result).toMatchObject({ peer: 'server', vm: 'plugin', met: true, polls: 13, value: 3 });
    expect(calls[0].endpoint).toBe('/api/execute-luau');
    expect(calls[0].timeoutMs).toBeGreaterThan(30_000);
    expect(argsOf(calls[0].code)).toEqual({ timeout_s: 30, interval_ms: 100, yield_s: 30 });
    expect(calls[0].code).toContain('return (\nworkspace.Coins.Value >= 3\n)');
  });

  test('defaults to edit without a playtest and refuses the game VM there', async () => {
    const { host, calls } = fakeHost(['edit'], () => ok({ met: false, elapsed_s: 0, polls: 1 }));
    expect((await waitForCondition(host, { condition: 'false', timeout_s: 0 }, undefined)).peer).toBe('edit');
    await expect(waitForCondition(host, { condition: 'true', vm: 'game' }, undefined)).rejects.toThrow(/vm=game needs a playtest peer/);
    await expect(waitForCondition(host, { condition: 'true', vm: 'server' }, undefined)).rejects.toThrow(/vm must be plugin or game/);
    expect(calls).toHaveLength(1);
  });

  test('the game VM goes through eval-runtime and errors name the caller line', async () => {
    const { host, calls } = fakeHost(['edit', 'server', 'client-1'], (call) => (call.peerId === 'client-1'
      ? { bridge: 'ok', ok: false, error: 'user_code:5: attempt to index nil with \'Value\'' }
      : { bridge: 'ok', ok: true, result: JSON.stringify({ met: true, elapsed_s: 0, polls: 1, value: true }) }));
    expect(await waitForCondition(host, { condition: 'Cooldowns.ready', vm: 'game' }, undefined)).toMatchObject({ met: true, vm: 'game' });
    expect(calls[0].endpoint).toBe('/api/eval-runtime');
    await expect(waitForCondition(host, { condition: 'x.Value', vm: 'game', peer: 'client-1' }, undefined))
      .rejects.toThrow("condition:1: attempt to index nil with 'Value'");
  });

  test('a last_error from a later poll is mapped to the caller line', async () => {
    const { host } = fakeHost(['edit'], () => ok({ met: false, elapsed_s: 1, polls: 10, last_error: "user_code:6: attempt to index nil with 'c'" }));
    const result = await waitForCondition(host, { condition: 'local a = 1\nlocal b = nil\nreturn b.c', timeout_s: 1 }, undefined);
    expect(result.last_error).toBe("condition:3: attempt to index nil with 'c'");
  });

  test('log mode only matches lines logged after the call started, from any peer', async () => {
    const { host, log } = fakeHost(['edit', 'server'], () => ok({}));
    log('server', 'OUT', 'Round started');
    setTimeout(() => log('server', 'OUT', 'Round started (round 2)'), 300);
    const result = await waitForLog(host, { log: '/Round started \\(round (\\d)\\)/', timeout_s: 3 }, undefined);
    expect(result).toMatchObject({ met: true, peer: 'server', value: 'Round started (round 2)' });
    expect(result.polls).toBeGreaterThan(1);
    const missed = await waitForLog(host, { log: 'never', timeout_s: 0.3 }, undefined);
    expect(missed).toMatchObject({ met: false });
  });

  test('log mode fails at once for a peer that is not connected instead of timing out empty', async () => {
    const { host } = fakeHost(['edit'], () => ok({}));
    const started = Date.now();
    await expect(waitForLog(host, { log: 'Round started', peer: 'server', timeout_s: 5 }, undefined)).rejects.toThrow(/no server/);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test('the handler refuses condition and log together and rejects bad regexes', async () => {
    const { host } = fakeHost(['edit'], () => ok({}));
    const tools = { forkHost: host } as unknown as RobloxStudioTools;
    await expect(playtestFeature.handlers.wait_for(tools, { condition: 'true', log: 'x' })).rejects.toThrow(/not both/);
    await expect(playtestFeature.handlers.wait_for(tools, { log: '/(/' })).rejects.toThrow(/not a valid regex/);
  });
});

describe('watch', () => {
  test('cleans sentinels, adds magnitude series and summarizes every sample', () => {
    const shaped = shapeSamples({
      t: [0, 0.1, 0.2],
      series: { speed: [[0, 0, 0], [3, 4, 0], [6, 8, 0]], hp: [100, '<error>', 80], state: ['Idle', 'Run', 'Run'], gone: ['<nil>', '<nil>', '<nil>'] },
      magnitudes: { speed: [0, 5, 10] },
      errors: { hp: { count: 1, first: 'attempt to index nil' } },
    });
    expect(Object.keys(shaped.series)).toEqual(['speed', 'speed.magnitude', 'hp', 'state', 'gone']);
    expect(shaped.series.hp).toEqual([100, null, 80]);
    expect(shaped.summary['speed.magnitude']).toEqual({ first: 0, last: 10, min: 0, max: 10, delta: 10 });
    expect(shaped.summary.speed).toEqual({ first: [0, 0, 0], last: [6, 8, 0], delta: [6, 8, 0] });
    expect(shaped.summary.state).toEqual({ first: 'Idle', last: 'Run', changes: 1 });
    expect(shaped.summary.gone).toEqual({ first: null, last: null });
    expect(shaped.errors).toEqual({ hp: { count: 1, first: 'attempt to index nil' } });
    expect(shaped).not.toHaveProperty('decimated');
  });

  test('decimates past the limit but keeps both ends and the true extremes', () => {
    const values = Array.from({ length: 1875 }, (_, index) => (index === 7 ? -999 : index));
    const shaped = shapeSamples({ t: values.map((_, index) => index / 100), series: { v: values }, magnitudes: [], errors: [] }, 600);
    expect(shaped.t).toHaveLength(600);
    expect(shaped.series.v[0]).toBe(0);
    expect(shaped.series.v[599]).toBe(1874);
    expect(shaped.series.v).not.toContain(-999);
    expect(shaped.summary.v).toMatchObject({ min: -999, max: 1874 });
    expect(shaped.decimated).toMatchObject({ from: 1875, to: 600 });
  });

  test('validates expressions and sends names, action and timing to the peer', async () => {
    const { host, calls } = fakeHost(['edit'], () => ok({ t: [0, 0.1], series: { y: [1, 2] }, magnitudes: [], errors: [] }));
    await expect(watchValues(host, { expressions: {} }, undefined)).rejects.toThrow(/1 to 10/);
    const many = Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`e${index}`, '1']));
    await expect(watchValues(host, { expressions: many }, undefined)).rejects.toThrow(/1 to 10/);
    await expect(watchValues(host, { expressions: { a: '' } }, undefined)).rejects.toThrow(/non-empty/);
    const result = await watchValues(host, { expressions: { y: 'workspace.Ball.Position.Y' }, action: 'jump()', duration_ms: 1000, interval_ms: 5 }, undefined);
    expect(result).toMatchObject({ peer: 'edit', interval_ms: 16, samples: 2, summary: { y: { min: 1, max: 2, delta: 1 } } });
    expect(argsOf(calls[0].code)).toEqual({ names: ['y'], duration_ms: 1000, interval_ms: 16, has_action: true });
    expect(calls[0].timeoutMs).toBeGreaterThan(1000);
  });
});

describe('playtest_scenario', () => {
  type Capture = { instanceId?: string; format?: string; quality?: number; options: Record<string, unknown> };

  function scenarioTools(roles: string[], conditions: Record<string, unknown>, imageData = 'SU1H') {
    const fake = fakeHost(roles, (call) => {
      if (call.code.includes('FindFirstChildOfClass("Humanoid")')) return ok({ met: true, elapsed_s: 0.5, polls: 5 });
      if (call.code.includes('GuiService')) return ok({ x: 120, y: 340, path: 'game.Players.Player1.PlayerGui.Shop.Buy' });
      if (call.code.includes('last_error = failure')) {
        const key = Object.keys(conditions).find((name) => call.code.includes(`\n${name}\n`));
        const value = key === undefined ? null : conditions[key];
        if (value === 'error') return ok({ met: false, elapsed_s: 0, polls: 1, last_error: 'attempt to index nil' });
        if (key === 'Coins == 1') fake.log('server', 'ERR', 'ServerScriptService.Shop:12: attempt to compare nil < number');
        return ok({ met: value !== null && value !== false, elapsed_s: 0, polls: 1, value });
      }
      if (call.code.includes('returned = results.n > 0')) {
        if (call.code.includes('warn("spam")')) {
          for (let i = 0; i < 3; i++) fake.log('server', 'WARN', 'spam');
          return ok({ returned: false });
        }
        return ok({ returned: true, value: { coins: 1 } });
      }
      if (call.code.includes('local function sample(value)')) return ok({ t: [0, 0.1], series: { hp: [100, 90] }, magnitudes: [], errors: [] });
      return ok({});
    });
    const inputs: Array<Record<string, unknown>> = [];
    const captures: Capture[] = [];
    const walks: Array<Record<string, unknown>> = [];
    const recordings: Array<{ instanceId?: string; options: Record<string, unknown> }> = [];
    const fork = new ForkTools(fake.host);
    fork.navigateCharacter = async (body: Record<string, unknown>) => {
      walks.push(body);
      if (body.path === 'workspace.Fenced') {
        return text({ reached: false, distance: 30, stopped: 'stalled', blocked: { waypoint: 4, by: { path: 'game.Workspace.Map.Fence' } } });
      }
      if (body.path === 'workspace.Slow') return text({ reached: false, distance: 8, stopped: 'timeout' });
      return text(body.path === 'workspace.Far' ? { reached: false, distance: 12.5 } : { reached: true, distance: 0.4 });
    };
    const tools = {
      forkHost: fake.host,
      fork,
      simulateKeyboardInput: async (keyCode?: string, action?: string, duration?: number, typed?: string, target?: string) => {
        inputs.push({ keyCode, action, duration, typed, target });
        return text({ success: true });
      },
      simulateMouseInput: async (action: string, x: number, y: number, _button?: string, _scroll?: string, target?: string) => {
        inputs.push({ action, x, y, target });
        return text(target === 'client-9' ? { error: 'target_role_not_present_on_instance' } : { success: true });
      },
      captureScreenshot: async (instanceId?: string, format?: string, quality?: number, options: Record<string, unknown> = {}) => {
        captures.push({ instanceId, format, quality, options });
        const image = { type: 'image', data: imageData, mimeType: 'image/jpeg' };
        const clients = options.clients as string[] | undefined;
        if (clients?.includes('client-7')) {
          return text({ error: 'No screenshot was captured.', images: [{ label: 'client-7', client: 'client-7', error: 'Failed to load texture' }] });
        }
        if (clients) {
          const fields = { width: 1280, height: 720, originalWidth: 2560, originalHeight: 1440, scale: { x: 2, y: 2 } };
          return { content: [{ type: 'text', text: JSON.stringify({ images: [{ image: 1, label: clients[0], client: clients[0], ...fields }] }) }, image] };
        }
        return { content: [{ type: 'text', text: JSON.stringify({ width: 800, height: 600, originalWidth: 800, originalHeight: 600 }) }, image] };
      },
      recordViewport: async (instanceId: string | undefined, options: Record<string, unknown>) => {
        recordings.push({ instanceId, options });
        const summary = { frames: 20, studioFps: 60, sheet: { frames: 4, files: ['frame-0001-0ms.png'], stamps: [17.5] } };
        return { content: [{ type: 'text', text: JSON.stringify(summary) }, { type: 'image', data: imageData, mimeType: 'image/jpeg' }] };
      },
    } as unknown as RobloxStudioTools;
    return { ...fake, tools, inputs, captures, walks, recordings };
  }

  const scenario = (tools: RobloxStudioTools, body: Record<string, unknown>, signal?: AbortSignal) =>
    playtestFeature.handlers.playtest_scenario(tools, body, signal ? { signal } : undefined);

  test('starts play, waits for the character, runs steps, stops at the first failure and still stops the playtest', async () => {
    const { tools, inputs, playtest, log, calls, captures } = scenarioTools(['edit'], { 'Coins == 0': true, 'Coins == 1': false });
    log('edit', 'ERR', 'an error from before the scenario');
    const result = await scenario(tools, {
      steps: [
        { key: 'E', hold_s: 0.25, label: 'open shop' },
        { click: 'PlayerGui.Shop.Buy' },
        { wait: 0 },
        { expect: 'Coins == 0' },
        { run: 'return { coins = Coins }', vm: 'plugin' },
        { screenshot: 'after buy' },
        { expect: 'Coins == 1' },
        { text: 'never typed' },
      ],
    });
    const report = json(result);
    expect(playtest).toEqual(['start:play', 'stop']);
    expect(report.ok).toBe(false);
    expect(report.playtest).toEqual({ started: true, stopped: true, character_ready: true });
    expect(report.steps.map((step: { kind: string; ok: boolean }) => [step.kind, step.ok])).toEqual([
      ['key', true], ['click', true], ['wait', true], ['expect', true], ['run', true], ['screenshot', true], ['expect', false],
    ]);
    expect(report.steps[0].label).toBe('open shop');
    expect(report.steps[1].value).toEqual({ x: 120, y: 340 });
    expect(report.steps[4].value).toEqual({ coins: 1 });
    expect(report.steps[6].error).toBe('expected a truthy value, got false');
    expect(report.not_run).toBe(1);
    expect(report.assertions).toEqual({ passed: 1, failed: 1 });
    // The capture comes from the client the inputs went to, and its scale is kept so image coordinates can be converted.
    expect(captures[0].options).toEqual({ max_width: 1280, clients: ['client-1'] });
    expect(report.screenshots).toEqual([{ label: 'after buy', step: 6, image: 1, width: 1280, height: 720, scale: { x: 2, y: 2 }, client: 'client-1' }]);
    expect(result.content[1]).toEqual({ type: 'image', data: 'SU1H', mimeType: 'image/jpeg' });
    expect(report.logs.errors).toEqual([{ message: 'ServerScriptService.Shop:12: attempt to compare nil < number', count: 1, peers: ['server'] }]);
    expect(inputs[0]).toEqual({ keyCode: 'E', action: 'tap', duration: 0.25, typed: undefined, target: 'client-1' });
    expect(inputs[1]).toEqual({ action: 'click', x: 120, y: 340, target: 'client-1' });
    expect(calls.find((call) => call.code.includes('FindFirstChildOfClass("Humanoid")'))!.peerId).toBe('client-1');
    const expectCall = calls.find((call) => call.code.includes('\nCoins == 0\n'))!;
    expect(argsOf(expectCall.code)).toMatchObject({ timeout_s: 0, yield_s: 5 });
    for (const step of report.steps) expect(step.ms_offset).toBeGreaterThanOrEqual(0);
  });

  test('leaves a running playtest alone, groups repeated warnings and continues past failures when asked', async () => {
    const { tools, playtest, log } = scenarioTools(['edit', 'server', 'client-1'], { 'Bad.Path': 'error' });
    log('server', 'ERR', 'old error before the scenario');
    const result = await scenario(tools, {
      stop_on_failure: false,
      steps: [
        { run: 'for i = 1, 3 do warn("spam") end' },
        { expect: 'Bad.Path' },
        { click: { x: 5, y: 6 }, client: 'client-9' },
        { key: 'Space' },
      ],
    });
    log('client-1', 'WARN', 'after the scenario');
    const report = json(result);
    expect(playtest).toEqual([]);
    expect(report.playtest).toEqual({ started: false, stopped: false });
    expect(report.steps.map((step: { ok: boolean }) => step.ok)).toEqual([true, false, false, true]);
    expect(report.steps[0]).not.toHaveProperty('value');
    expect(report.steps[1].error).toBe('errored: attempt to index nil');
    expect(report.steps[2].error).toMatch(/target_role_not_present_on_instance/);
    expect(report.not_run).toBeUndefined();
    expect(report.logs.errors).toEqual([]);
    expect(report.logs.warnings).toEqual([{ message: 'spam', count: 3, peers: ['server'] }]);
  });

  test('dedupes identical log lines across peers with counts', async () => {
    const { tools, log } = scenarioTools(['edit', 'server', 'client-1'], {});
    const pending = scenario(tools, { steps: [{ wait: 0.1 }] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (let i = 0; i < 3; i++) log('server', 'WARN', 'Infinite yield possible on Foo');
    log('client-1', 'WARN', 'Infinite yield possible on Foo');
    log('client-1', 'OUT', 'plain output is ignored');
    const report = json(await pending);
    expect(report.logs.warnings).toEqual([{ message: 'Infinite yield possible on Foo', count: 4, peers: ['server', 'client-1'] }]);
    expect(report.logs.errors).toEqual([]);
  });

  test('drains the log buffers between steps once LOG_DRAIN_MS has passed, without double counting', async () => {
    const { tools, log, logReads } = scenarioTools(['edit'], {});
    const pending = scenario(tools, { start: 'none', steps: [{ wait: 1.05 }, { wait: 0 }] });
    setTimeout(() => log('edit', 'ERR', 'during the first wait'), 100);
    const report = json(await pending);
    // begin, the drain after the first step, and the final read.
    expect(logReads).toEqual(['edit', 'edit', 'edit']);
    expect(report.logs.errors).toEqual([{ message: 'during the first wait', count: 1, peers: ['edit'] }]);
  });

  test('keep_running leaves a playtest it started up, and run mode skips the character wait', async () => {
    const { tools, playtest, calls } = scenarioTools(['edit'], {});
    const report = json(await scenario(tools, { start: 'run', keep_running: true, steps: [{ run: 'return 1' }] }));
    expect(playtest).toEqual(['start:run']);
    expect(report.playtest).toEqual({ started: true, stopped: false });
    expect(calls.some((call) => call.code.includes('FindFirstChildOfClass("Humanoid")'))).toBe(false);
    expect(calls[0].peerId).toBe('server');
  });

  test('start none never starts a playtest, and screenshots then show the edit viewport', async () => {
    const { tools, playtest, captures } = scenarioTools(['edit'], {});
    const report = json(await scenario(tools, { start: 'none', quality: 55, max_width: 640, steps: [{ screenshot: 'edit view' }] }));
    expect(playtest).toEqual([]);
    expect(captures).toEqual([{ instanceId: undefined, format: 'jpeg', quality: 55, options: { max_width: 640 } }]);
    expect(report.screenshots).toEqual([{ label: 'edit view', step: 1, image: 1, width: 800, height: 600 }]);
  });

  test('screenshots follow the step client and report a client capture failure', async () => {
    const { tools, captures } = scenarioTools(['edit', 'server', 'client-1', 'client-2'], {});
    const report = json(await scenario(tools, {
      client: 'client-2',
      stop_on_failure: false,
      steps: [{ screenshot: 'two' }, { screenshot: 'seven', client: 'client-7' }],
    }));
    expect(captures.map((capture) => capture.options.clients)).toEqual([['client-2'], ['client-7']]);
    expect(report.screenshots).toEqual([expect.objectContaining({ label: 'two', client: 'client-2', scale: { x: 2, y: 2 } })]);
    expect(report.steps[1]).toMatchObject({ ok: false, error: 'Failed to load texture' });
  });

  test('all screenshots of one call share the 8 MB budget', async () => {
    // 4,000,000 base64 characters decode to 3 MB, so the third image would pass 8 MB.
    const { tools } = scenarioTools(['edit'], {}, 'A'.repeat(4_000_000));
    const result = await scenario(tools, {
      start: 'none',
      stop_on_failure: false,
      steps: [{ screenshot: 'one' }, { screenshot: 'two' }, { screenshot: 'three' }],
    });
    const report = json(result);
    expect(report.steps.map((step: { ok: boolean }) => step.ok)).toEqual([true, true, false]);
    expect(report.steps[2].error).toMatch(/would pass the 8 MB screenshot budget \(6\.0 MB used\)/);
    expect(result.content.filter((item: { type: string }) => item.type === 'image')).toHaveLength(2);
    expect(report.screenshots.map((shot: { image: number }) => shot.image)).toEqual([1, 2]);
  });

  test('text, walk_to, wait_for and watch steps', async () => {
    const { tools, inputs, walks } = scenarioTools(['edit', 'server', 'client-1'], { 'Door.Open': true, 'Never.True': false });
    const report = json(await scenario(tools, {
      stop_on_failure: false,
      steps: [
        { text: 'hello' },
        { walk_to: 'workspace.Shop' },
        { walk_to: { path: 'workspace.Far' }, timeout_s: 9 },
        { walk_to: { position: { x: 0, y: 3, z: 20 } } },
        { walk_to: { x: 1, y: 2, z: 3 }, client: 'client-2' },
        { wait_for: 'Door.Open' },
        { wait_for: 'Never.True', timeout_s: 0 },
        { watch: { hp: 'Humanoid.Health' }, duration_ms: 200 },
      ],
    }));
    expect(inputs[0]).toEqual({ keyCode: undefined, action: undefined, duration: undefined, typed: 'hello', target: 'client-1' });
    expect(walks).toEqual([
      { path: 'workspace.Shop', timeout_s: undefined, target: 'client-1', instance_id: undefined },
      { path: 'workspace.Far', timeout_s: 9, target: 'client-1', instance_id: undefined },
      { position: { x: 0, y: 3, z: 20 }, timeout_s: undefined, target: 'client-1', instance_id: undefined },
      { position: { x: 1, y: 2, z: 3 }, timeout_s: undefined, target: 'client-2', instance_id: undefined },
    ]);
    expect(report.steps.map((step: { ok: boolean }) => step.ok)).toEqual([true, true, false, true, true, true, false, true]);
    expect(report.steps[2].error).toBe('stopped 12.5 studs from the goal');
    expect(report.steps[5].value).toMatchObject({ met: true, peer: 'server' });
    expect(report.steps[6].error).toMatch(/^not met after 0s/);
    expect(report.steps[7].value).toMatchObject({ samples: 2, summary: { hp: { first: 100, last: 90 } } });
  });

  test('a failed walk names the part that blocked it, or why it stopped', async () => {
    const { tools } = scenarioTools(['edit', 'server', 'client-1'], {});
    const report = json(await scenario(tools, { stop_on_failure: false, steps: [{ walk_to: 'workspace.Fenced' }, { walk_to: 'workspace.Slow' }] }));
    expect(report.steps.map((step: { error?: string }) => step.error)).toEqual([
      'blocked by game.Workspace.Map.Fence at waypoint 4, 30 studs from the goal',
      'timeout, 8 studs from the goal',
    ]);
  });

  test('an abort before the first step runs nothing but still stops the playtest it started', async () => {
    const { tools, playtest } = scenarioTools(['edit'], {});
    const controller = new AbortController();
    controller.abort();
    const report = json(await scenario(tools, { steps: [{ key: 'E' }, { key: 'F' }] }, controller.signal));
    expect(report).toMatchObject({ ok: false, aborted: true, not_run: 2, steps: [] });
    expect(playtest).toEqual(['start:play', 'stop']);
  });

  test('a failed stop is reported instead of thrown', async () => {
    const { tools, host } = scenarioTools(['edit'], {});
    const solo = host.soloPlaytest;
    host.soloPlaytest = async (action, mode, timeout, instanceId) => (action === 'stop'
      ? text({ success: false, error: 'Playtest teardown did not complete.', message: 'BindToClose is blocking' })
      : solo(action, mode, timeout, instanceId));
    const report = json(await scenario(tools, { steps: [{ wait: 0 }] }));
    expect(report.ok).toBe(true);
    expect(report.playtest).toMatchObject({ started: true, stopped: false, stop_error: 'BindToClose is blocking' });
  });

  test('a record step records in the same call and adds its grid to the images', async () => {
    const { tools, recordings, playtest } = scenarioTools(['edit'], { 'Take > 17': true });
    const report = json(await scenario(tools, {
      steps: [
        { wait_for: 'Take > 17' },
        { record: 2, stamp: 'Take', fps: 20, frame_width: 320, sheet_frames: 8, label: 'finish' },
      ],
    }));
    expect(playtest).toEqual(['start:play', 'stop']);
    expect(recordings).toEqual([{ instanceId: undefined, options: { duration_s: 2, fps: 20, frame_width: 320, sheet_frames: 8, stamp: 'Take' } }]);
    expect(report.steps[1]).toMatchObject({ kind: 'record', ok: true, label: 'finish', value: { studioFps: 60, image: 1, sheet: { stamps: [17.5] } } });
    expect(report.screenshots).toEqual([{ label: 'finish', step: 2, image: 1, recording: true }]);
  });

  test('record steps are checked and capped before the playtest starts', async () => {
    const { tools, playtest } = scenarioTools(['edit'], {});
    const run = (steps: unknown) => scenario(tools, { steps });
    await expect(run([{ record: 0.1 }])).rejects.toThrow(/step 1 \(record\) needs a number of seconds from 0\.5 to 30/);
    await expect(run([{ record: 31 }])).rejects.toThrow(/from 0\.5 to 30/);
    await expect(run(Array.from({ length: 5 }, () => ({ record: 1 })))).rejects.toThrow(/at most 4 record steps/);
    expect(playtest).toEqual([]);
  });

  test('rejects malformed steps before touching the playtest', async () => {
    const { tools, playtest } = scenarioTools(['edit'], {});
    const run = (steps: unknown) => scenario(tools, { steps });
    await expect(run([])).rejects.toThrow(/non-empty/);
    await expect(run([{ key: 'E', wait: 1 }])).rejects.toThrow(/step 1 needs exactly one of .* found key and wait/);
    await expect(run([{ label: 'nothing' }])).rejects.toThrow(/found none/);
    await expect(run([{ click: { x: 1 } }])).rejects.toThrow(/step 1 \(click\) needs a GuiObject path/);
    await expect(run([{ wait: 1 }, { walk_to: { x: 1, y: 2 } }])).rejects.toThrow(/step 2 \(walk_to\)/);
    await expect(run([{ walk_to: { position: { x: 1 } } }])).rejects.toThrow(/step 1 \(walk_to\)/);
    await expect(run([{ watch: {} }])).rejects.toThrow(/expressions needs 1 to 10/);
    await expect(run(Array.from({ length: 11 }, () => ({ screenshot: 'x' })))).rejects.toThrow(/at most 10 screenshots/);
    expect(playtest).toEqual([]);
    expect(parseSteps([{ walk_to: { x: 1, y: 2, z: 3 }, timeout_s: 5 }])[0]).toMatchObject({ kind: 'walk_to', arg: { x: 1, y: 2, z: 3 } });
    expect(parseSteps([{ walk_to: { position: { x: 0, y: 3, z: 20 } } }])[0].kind).toBe('walk_to');
  });

  test('a failed start throws with the reason and runs nothing', async () => {
    const { tools, host, inputs } = scenarioTools(['edit'], {});
    host.soloPlaytest = async () => text({ success: false, error: 'start_failed', message: 'Playtest did not start.' });
    await expect(scenario(tools, { steps: [{ key: 'E' }] })).rejects.toThrow(/could not start the playtest: Playtest did not start\.$/);
    expect(inputs).toEqual([]);
  });

  test('a start whose roles never became ready is stopped before the error is thrown', async () => {
    const { tools, host, inputs } = scenarioTools(['edit'], {});
    const actions: string[] = [];
    host.soloPlaytest = async (action) => {
      actions.push(action);
      return action === 'start'
        ? text({ success: false, error: 'start_failed', message: 'Playtest did not become ready before timeout.', runtimeReady: false, timedOut: true })
        : text({ success: true });
    };
    await expect(scenario(tools, { steps: [{ key: 'E' }] }))
      .rejects.toThrow(/did not become ready before timeout\. The partly started playtest was stopped\./);
    expect(actions).toEqual(['start', 'stop']);
    expect(inputs).toEqual([]);
  });

  test('a start refused because another playtest already runs leaves that playtest alone', async () => {
    const { tools, host } = scenarioTools(['edit'], {});
    const actions: string[] = [];
    host.soloPlaytest = async (action) => {
      actions.push(action);
      return text({ success: false, error: 'Playtest already running.', message: 'Stop the current playtest first.', runtimeReady: true });
    };
    await expect(scenario(tools, { steps: [{ key: 'E' }] })).rejects.toThrow(/Stop the current playtest first\.$/);
    expect(actions).toEqual(['start']);
  });
});

describe('generated snippets', () => {
  (compiler ? test : test.skip)('every snippet sent to a fake peer compiles as Luau', () => {
    expect(sentCode.size).toBeGreaterThan(5);
    let index = 0;
    for (const code of sentCode) {
      const result = compile(`sent-${index++}`, code);
      expect(result.stderr + result.stdout).not.toMatch(/error/i);
      expect(result.status).toBe(0);
    }
  });
});
