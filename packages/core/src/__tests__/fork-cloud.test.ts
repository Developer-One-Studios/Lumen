import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RoutingFailure } from '../bridge-service.js';
import { SourcemapResolver } from '../sourcemap.js';
import type { RobloxStudioTools } from '../tools/index.js';
import { sourcemaps, type ForkHost } from '../tools/fork-tools.js';
import { PLACE_IDS_LUAU, cloudFeature, runCloudLuau, studioPlace } from '../tools/fork/cloud.js';

const API = 'https://apis.roblox.com/cloud/v2';
const TASK = 'universes/10/places/20/versions/7/luau-execution-sessions/s-1/tasks/t-1';
const FAST = { pollMs: { first: 1, max: 2 }, graceMs: 0 };

type Call = { url: string; method: string; headers: Record<string, string>; body?: Record<string, unknown> };

function mockFetch(route: (call: Call) => { status?: number; body: unknown } | Response) {
  const calls: Call[] = [];
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    init?.signal?.throwIfAborted();
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const reply = route(call);
    if (reply instanceof Response) return reply;
    return new Response(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body), { status: reply.status ?? 200 });
  });
  return calls;
}

// A reply whose headers arrived but whose body read fails, like undici on a reset socket.
function brokenBody(): Response {
  const response = new Response('{}');
  Object.defineProperty(response, 'text', { value: () => Promise.reject(new TypeError('terminated')) });
  return response;
}

const isLogs = (call: Call) => call.url.startsWith(`${API}/${TASK}/logs`);

function fakeHost(ids: { gameId: number; placeId: number }) {
  const seen: Array<{ target?: string; instanceId?: string; code?: string }> = [];
  const host: ForkHost = {
    peerTargets: async (target, instanceId) => {
      seen.push({ target, instanceId });
      return [{ role: 'edit', peerId: 'e' }];
    },
    requestPeer: async (_endpoint, data) => {
      seen.push({ code: (data as { code: string }).code });
      return { success: true, returnValue: JSON.stringify(ids) };
    },
    soloPlaytest: async () => ({ content: [] }),
    getRuntimeLogs: async () => ({ content: [] }),
  };
  return { host, seen };
}

const noStudio = async (): Promise<never> => {
  throw new Error('Studio must not be asked');
};

let project: string;

beforeAll(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-cloud-'));
  fs.mkdirSync(path.join(project, 'tests'));
  fs.writeFileSync(path.join(project, 'tests', 'run.luau'), 'return "from file"');
  fs.writeFileSync(path.join(project, 'secret.txt'), 'token');
  fs.writeFileSync(path.join(project, 'sourcemap.json'), JSON.stringify({
    name: 'Game',
    className: 'DataModel',
    children: [{
      name: 'ServerScriptService',
      className: 'ServerScriptService',
      children: [{ name: 'Combat', className: 'ModuleScript', filePaths: ['src/server/Combat.luau'] }],
    }],
  }));
  sourcemaps.setProjectRoot(project);
});

beforeEach(() => {
  process.env.ROBLOX_OPEN_CLOUD_API_KEY = 'test-key';
});

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.ROBLOX_OPEN_CLOUD_API_KEY;
});

describe('cloud_luau', () => {
  test('refuses to run without an API key', async () => {
    delete process.env.ROBLOX_OPEN_CLOUD_API_KEY;
    const calls = mockFetch(() => ({ body: {} }));
    await expect(runCloudLuau({ script: 'return 1' }, { studioPlace: noStudio, ...FAST })).rejects.toThrow(/ROBLOX_OPEN_CLOUD_API_KEY/);
    expect(calls).toHaveLength(0);
  });

  test('creates a task for the open place, polls to completion and summarizes every log page', async () => {
    const { host, seen } = fakeHost({ gameId: 10, placeId: 20 });
    const states = ['PROCESSING', 'COMPLETE'];
    const calls = mockFetch((call) => {
      if (call.method === 'POST') return { body: { path: TASK, state: 'QUEUED' } };
      if (call.url === `${API}/${TASK}`) {
        const state = states.shift()!;
        return { body: { path: TASK, state, ...(state === 'COMPLETE' ? { output: { results: [{ suites: 2 }, 'done'] } } : {}) } };
      }
      if (call.url.includes('pageToken=p2')) return { body: { luauExecutionSessionTaskLogs: [{ messages: ['[Test] 2 passed, 1 failed'] }] } };
      return {
        body: {
          luauExecutionSessionTaskLogs: [{
            path: `${TASK}/logs/1`,
            structuredMessages: [
              { message: '[Test] PASS damage applies', messageType: 'OUTPUT' },
              { message: '[Test] FAIL  shield blocks: expected 0', messageType: 'WARNING' },
              { message: 'ServerScriptService.Combat:12: attempt to index nil', messageType: 'ERROR' },
            ],
          }],
          nextPageToken: 'p2',
        },
      };
    });

    const result = await runCloudLuau(
      { script: 'return 1', max_log_lines: 3, instance_id: 'inst-1' },
      { studioPlace: () => studioPlace(host, 'inst-1'), ...FAST },
    );

    expect(seen).toEqual([{ target: 'edit', instanceId: 'inst-1' }, { code: PLACE_IDS_LUAU }]);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `${API}/universes/10/places/20/luau-execution-session-tasks`,
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      body: { script: 'return 1', timeout: '120s' },
    });
    expect(calls.filter((call) => call.url === `${API}/${TASK}`)).toHaveLength(2);
    const logCalls = calls.filter((call) => call.url.startsWith(`${API}/${TASK}/logs`));
    expect(logCalls).toHaveLength(2);
    expect(logCalls.every((call) => call.url.includes('view=STRUCTURED'))).toBe(true);
    expect(calls.every((call) => call.headers['x-api-key'] === 'test-key')).toBe(true);

    expect(result).toMatchObject({
      state: 'COMPLETE',
      taskPath: TASK,
      results: [{ suites: 2 }, 'done'],
      summaries: ['2 passed, 1 failed'],
      passed: 2,
      failed: 1,
      failures: ['shield blocks: expected 0'],
      errors: ['ServerScriptService.Combat:12 [src/server/Combat.luau:12]: attempt to index nil'],
      logsTruncated: true,
      totalLogLines: 4,
    });
    expect(result.logs).toEqual([
      '[WARNING] [Test] FAIL  shield blocks: expected 0',
      '[ERROR] ServerScriptService.Combat:12 [src/server/Combat.luau:12]: attempt to index nil',
      '[Test] 2 passed, 1 failed',
    ]);
  });

  test('reports a failed task with its error and no test counts', async () => {
    const calls = mockFetch((call) => {
      if (call.method === 'POST') return { body: { path: TASK, state: 'QUEUED' } };
      if (call.url === `${API}/${TASK}`) return { body: { path: TASK, state: 'FAILED', error: { code: 'SCRIPT_ERROR', message: 'ServerScriptService.Combat:3: boom' } } };
      return { body: { luauExecutionSessionTaskLogs: [] } };
    });
    const result = await runCloudLuau(
      { script: 'error("x")', universe_id: 10, place_id: 20, place_version: 7, timeout_s: 30 },
      { studioPlace: noStudio, ...FAST },
    );
    expect(calls[0].url).toBe(`${API}/universes/10/places/20/versions/7/luau-execution-session-tasks`);
    expect(calls[0].body).toEqual({ script: 'error("x")', timeout: '30s' });
    expect(result).toMatchObject({
      state: 'FAILED',
      error: { code: 'SCRIPT_ERROR', message: 'ServerScriptService.Combat:3 [src/server/Combat.luau:3]: boom' },
      results: [],
      logs: [],
    });
    expect(result).not.toHaveProperty('passed');
    expect(result).not.toHaveProperty('timedOut');
  });

  test('stops waiting at the timeout without reading logs, then resumes from task_path', async () => {
    let done = false;
    const calls = mockFetch((call) => {
      if (call.method === 'POST') return { body: { path: TASK, state: 'QUEUED' } };
      if (call.url === `${API}/${TASK}`) return { body: { path: TASK, state: done ? 'COMPLETE' : 'PROCESSING', ...(done ? { output: { results: [7] } } : {}) } };
      return { body: { luauExecutionSessionTaskLogs: [{ messages: ['hello'] }] } };
    });
    const pending = await runCloudLuau(
      { script: 'while true do task.wait() end', universe_id: 10, place_id: 20, timeout_s: 1 },
      { studioPlace: noStudio, pollMs: { first: 50, max: 100 }, graceMs: 0 },
    );
    expect(pending).toMatchObject({ state: 'PROCESSING', taskPath: TASK, timedOut: true });
    expect(String(pending.note)).toContain('task_path');
    expect(calls.some((call) => call.url.includes('/logs'))).toBe(false);

    done = true;
    calls.length = 0;
    const resumed = await runCloudLuau({ task_path: TASK }, { studioPlace: noStudio, ...FAST });
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
    expect(resumed).toMatchObject({ state: 'COMPLETE', results: [7], logs: ['hello'] });
  });

  test('looks up the universe of a bare place_id without Studio or the API key', async () => {
    const calls = mockFetch((call) => {
      if (call.url.includes('/universes/v1/places/')) return { body: { universeId: 10 } };
      if (call.method === 'POST') return { body: { path: TASK, state: 'COMPLETE', output: { results: [] } } };
      return { body: { luauExecutionSessionTaskLogs: [] } };
    });
    await runCloudLuau({ script: 'return 1', place_id: 20 }, { studioPlace: noStudio, ...FAST });
    expect(calls[0].url).toBe('https://apis.roblox.com/universes/v1/places/20/universe');
    expect(calls[0].headers['x-api-key']).toBeUndefined();
    expect(calls[1].url).toBe(`${API}/universes/10/places/20/luau-execution-session-tasks`);
  });

  test('reads script_file relative to the Rojo project and refuses non-Luau files', async () => {
    const calls = mockFetch((call) => {
      if (call.method === 'POST') return { body: { path: TASK, state: 'COMPLETE', output: { results: ['from file'] } } };
      return { body: { luauExecutionSessionTaskLogs: [] } };
    });
    const result = await runCloudLuau({ script_file: 'tests/run.luau', universe_id: 10, place_id: 20 }, { studioPlace: noStudio, ...FAST });
    expect(calls[0].body).toEqual({ script: 'return "from file"', timeout: '120s' });
    expect(result.scriptFile).toBe(fs.realpathSync(path.join(project, 'tests', 'run.luau')));

    await expect(runCloudLuau({ script_file: 'secret.txt', universe_id: 10, place_id: 20 }, { studioPlace: noStudio, ...FAST }))
      .rejects.toThrow(/\.luau or \.lua/);
    await expect(runCloudLuau({ script_file: 'missing.luau', universe_id: 10, place_id: 20 }, { studioPlace: noStudio, ...FAST }))
      .rejects.toThrow(/does not exist/);
  });

  test('waits for rojo to map a project without sourcemap.json before resolving a relative script_file', async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-cloud-bare-'));
    fs.writeFileSync(path.join(bare, 'default.project.json'), '{"name":"Game","tree":{"$className":"DataModel"}}');
    fs.mkdirSync(path.join(bare, 'tests'));
    fs.writeFileSync(path.join(bare, 'tests', 'run.luau'), 'return "bare"');
    let builds = 0;
    const resolver = new SourcemapResolver(() => bare, {
      env: {},
      runRojo: async () => {
        builds += 1;
        return JSON.stringify({ name: 'Game', className: 'DataModel', children: [] });
      },
    });
    const calls = mockFetch((call) => {
      if (call.method === 'POST') return { body: { path: TASK, state: 'COMPLETE', output: { results: [] } } };
      return { body: { luauExecutionSessionTaskLogs: [] } };
    });
    const result = await runCloudLuau({ script_file: 'tests/run.luau', universe_id: 10, place_id: 20 }, { studioPlace: noStudio, resolver, ...FAST });
    expect(builds).toBe(1);
    expect(calls[0].body).toEqual({ script: 'return "bare"', timeout: '120s' });
    expect(result.scriptFile).toBe(fs.realpathSync(path.join(bare, 'tests', 'run.luau')));
  });

  test('refuses a relative script_file when no Rojo project is known, but takes an absolute one', async () => {
    const calls = mockFetch((call) => {
      if (call.method === 'POST') return { body: { path: TASK, state: 'COMPLETE', output: { results: [] } } };
      return { body: { luauExecutionSessionTaskLogs: [] } };
    });
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-cloud-empty-'));
    const nowhere = new SourcemapResolver(() => empty, { env: {} });
    await expect(runCloudLuau({ script_file: 'tests/run.luau', universe_id: 10, place_id: 20 }, { studioPlace: noStudio, resolver: nowhere, ...FAST }))
      .rejects.toThrow(/tests\/run\.luau is relative but no Rojo project was found .*absolute path/);

    const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-cloud-norojo-'));
    fs.writeFileSync(path.join(broken, 'default.project.json'), '{}');
    const noRojo = new SourcemapResolver(() => broken, { env: {}, runRojo: async () => Promise.reject(new Error('rojo is not on PATH')) });
    await expect(runCloudLuau({ script_file: 'tests/run.luau', universe_id: 10, place_id: 20 }, { studioPlace: noStudio, resolver: noRojo, ...FAST }))
      .rejects.toThrow(/no Rojo project was found \(rojo is not on PATH\)/);
    expect(calls).toHaveLength(0);

    const absolute = path.join(project, 'tests', 'run.luau');
    const result = await runCloudLuau({ script_file: absolute, universe_id: 10, place_id: 20 }, { studioPlace: noStudio, resolver: nowhere, ...FAST });
    expect(calls[0].body).toEqual({ script: 'return "from file"', timeout: '120s' });
    expect(result.scriptFile).toBe(fs.realpathSync(absolute));
  });

  test('validates arguments before calling Roblox', async () => {
    const calls = mockFetch(() => ({ body: {} }));
    const run = (body: Record<string, unknown>, place = noStudio as () => Promise<{ universeId: number; placeId: number }>) =>
      runCloudLuau(body, { studioPlace: place, ...FAST });
    await expect(run({})).rejects.toThrow(/exactly one of script or script_file/);
    await expect(run({ script: 'return 1', script_file: 'tests/run.luau' })).rejects.toThrow(/exactly one/);
    await expect(run({ task_path: 'universes/1/places/2/../../../datastores' })).rejects.toThrow(/task_path/);
    await expect(run({ script: 'return 1', summary_pattern: '(' })).rejects.toThrow(/summary_pattern is not a valid/);
    await expect(run({ script: 'return 1', universe_id: -1, place_id: 2 })).rejects.toThrow(/universe_id must be a positive integer/);
    await expect(run({ script: 'return 1' }, async () => ({ universeId: 0, placeId: 0 }))).rejects.toThrow(/unpublished/);
    await expect(run({ script: 'return 1', universe_id: 99 }, async () => ({ universeId: 10, placeId: 20 }))).rejects.toThrow(/universe 10, not 99/);
    expect(calls).toHaveLength(0);
  });

  test('retries transient poll errors but surfaces permission errors with the needed scope', async () => {
    let polls = 0;
    mockFetch((call) => {
      if (call.method === 'POST') return { body: { path: TASK, state: 'QUEUED' } };
      if (call.url === `${API}/${TASK}`) {
        polls += 1;
        return polls === 1 ? { status: 503, body: 'unavailable' } : { body: { path: TASK, state: 'COMPLETE' } };
      }
      return { body: { luauExecutionSessionTaskLogs: [] } };
    });
    const result = await runCloudLuau({ script: 'return 1', universe_id: 10, place_id: 20 }, { studioPlace: noStudio, ...FAST });
    expect(result.state).toBe('COMPLETE');
    expect(polls).toBe(2);

    jest.restoreAllMocks();
    mockFetch(() => ({ status: 403, body: '{"message":"Forbidden"}' }));
    await expect(runCloudLuau({ script: 'return 1', universe_id: 10, place_id: 20 }, { studioPlace: noStudio, ...FAST }))
      .rejects.toThrow(/HTTP 403.*luau-execution-session:write/);
  });

  test('stops polling when the client cancels', async () => {
    const controller = new AbortController();
    const calls = mockFetch((call) => {
      if (call.method === 'POST') return { body: { path: TASK, state: 'QUEUED' } };
      controller.abort();
      return { body: { path: TASK, state: 'PROCESSING' } };
    });
    await expect(runCloudLuau(
      { script: 'return 1', universe_id: 10, place_id: 20 },
      { studioPlace: noStudio, signal: controller.signal, pollMs: { first: 1, max: 2 }, graceMs: 60_000 },
    )).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toHaveLength(2);
  });

  test('a cancel while reading logs aborts instead of returning partial logs', async () => {
    const controller = new AbortController();
    const calls = mockFetch((call) => {
      if (call.method === 'POST') return { body: { path: TASK, state: 'COMPLETE', output: { results: [] } } };
      controller.abort();
      return { status: 503, body: 'unavailable' };
    });
    const error = await runCloudLuau(
      { script: 'return 1', universe_id: 10, place_id: 20 },
      { studioPlace: noStudio, signal: controller.signal, ...FAST },
    ).catch((caught: unknown) => caught);
    expect(error).toBe(controller.signal.reason);
    expect(error).toMatchObject({ name: 'AbortError' });
    expect(calls.filter(isLogs)).toHaveLength(1);
  });

  test('retries a body that breaks off mid read like a network error', async () => {
    let polls = 0;
    mockFetch((call) => {
      if (call.method === 'POST') return { body: { path: TASK, state: 'QUEUED' } };
      if (call.url === `${API}/${TASK}`) {
        polls += 1;
        return polls === 1 ? brokenBody() : { body: { path: TASK, state: 'COMPLETE', output: { results: [1] } } };
      }
      return { body: { luauExecutionSessionTaskLogs: [] } };
    });
    const result = await runCloudLuau({ script: 'return 1', universe_id: 10, place_id: 20 }, { studioPlace: noStudio, ...FAST });
    expect(result).toMatchObject({ state: 'COMPLETE', results: [1] });
    expect(polls).toBe(2);
  });

  test('retries a transient log page error and keeps every line', async () => {
    let attempts = 0;
    mockFetch((call) => {
      if (call.method === 'POST') return { body: { path: TASK, state: 'COMPLETE', output: { results: [] } } };
      attempts += 1;
      if (attempts === 1) return { status: 429, body: 'slow down' };
      return { body: { luauExecutionSessionTaskLogs: [{ messages: ['4 passed, 0 failed'] }] } };
    });
    const result = await runCloudLuau({ script: 'return 1', universe_id: 10, place_id: 20 }, { studioPlace: noStudio, ...FAST });
    expect(attempts).toBe(2);
    expect(result).toMatchObject({ passed: 4, failed: 0, logs: ['4 passed, 0 failed'] });
    expect(result).not.toHaveProperty('logsIncomplete');
    expect(result).not.toHaveProperty('logsError');
  });

  test('a log page that keeps failing keeps the lines already read and says how to read them again', async () => {
    const calls = mockFetch((call) => {
      if (call.method === 'POST') return { body: { path: TASK, state: 'COMPLETE', output: { results: [] } } };
      if (call.url.includes('pageToken=p2')) return { status: 503, body: 'unavailable' };
      return { body: { luauExecutionSessionTaskLogs: [{ messages: ['PASS a', '3 passed, 0 failed'] }], nextPageToken: 'p2' } };
    });
    const result = await runCloudLuau({ script: 'return 1', universe_id: 10, place_id: 20 }, { studioPlace: noStudio, ...FAST });
    expect(calls.filter((call) => call.url.includes('pageToken=p2'))).toHaveLength(5);
    expect(result).toMatchObject({
      state: 'COMPLETE',
      taskPath: TASK,
      passed: 3,
      failed: 0,
      logs: ['PASS a', '3 passed, 0 failed'],
      logsIncomplete: true,
    });
    expect(String(result.logsError)).toMatch(/Reading task logs failed with HTTP 503/);
    expect(String(result.note)).toContain('task_path');
  });

  test('does not retry a log page that the key may not read', async () => {
    const calls = mockFetch((call) => {
      if (call.method === 'POST') return { body: { path: TASK, state: 'COMPLETE', output: { results: [5] } } };
      return { status: 403, body: 'forbidden' };
    });
    const result = await runCloudLuau({ script: 'return 1', universe_id: 10, place_id: 20 }, { studioPlace: noStudio, ...FAST });
    expect(calls.filter(isLogs)).toHaveLength(1);
    expect(result).toMatchObject({ state: 'COMPLETE', results: [5], logs: [], logsIncomplete: true });
    expect(String(result.logsError)).toMatch(/HTTP 403/);
  });

  test('marks the logs incomplete when the page limit is reached', async () => {
    let page = 0;
    mockFetch((call) => {
      if (call.method === 'POST') return { body: { path: TASK, state: 'COMPLETE', output: { results: [] } } };
      page += 1;
      return { body: { luauExecutionSessionTaskLogs: [{ messages: [`page ${page}`] }], nextPageToken: `p${page + 1}` } };
    });
    const result = await runCloudLuau({ script: 'return 1', universe_id: 10, place_id: 20 }, { studioPlace: noStudio, ...FAST });
    expect(page).toBe(5);
    expect(result).toMatchObject({ logsIncomplete: true, logs: ['page 1', 'page 2', 'page 3', 'page 4', 'page 5'] });
    expect(result).not.toHaveProperty('logsError');
  });

  test('bounds every log derived field and the results', async () => {
    const long = 'x'.repeat(5000);
    const messages = [
      long,
      ...Array.from({ length: 30 }, (_, i) => ({ message: `ServerScriptService.Combat:${i + 1}: ${long}`, messageType: 'ERROR' })),
      ...Array.from({ length: 60 }, (_, i) => `FAIL case ${i} ${long}`),
      ...Array.from({ length: 70 }, () => '1 passed, 0 failed'),
      ...Array.from({ length: 150 }, () => 'y'.repeat(1000)),
    ].map((entry) => (typeof entry === 'string' ? { message: entry, messageType: 'OUTPUT' } : entry));
    mockFetch((call) => {
      if (call.method === 'POST') return { body: { path: TASK, state: 'COMPLETE', output: { results: ['z'.repeat(70_000)] } } };
      return { body: { luauExecutionSessionTaskLogs: [{ structuredMessages: messages }] } };
    });
    const result = await runCloudLuau(
      { script: 'return 1', universe_id: 10, place_id: 20, max_log_lines: 2000 },
      { studioPlace: noStudio, ...FAST },
    );

    expect(result).toMatchObject({ resultsTruncated: true, logsTruncated: true, totalLogLines: messages.length });
    expect(String(result.results)).toHaveLength(60_001);

    const logs = result.logs as string[];
    expect(logs.reduce((total, line) => total + line.length, 0)).toBeLessThanOrEqual(100_000);
    expect(logs.at(-1)).toBe('y'.repeat(1000));

    const errors = result.errors as string[];
    expect(errors).toHaveLength(20);
    expect(result.errorsTruncated).toBe(true);
    expect(errors[0]).toMatch(/^ServerScriptService\.Combat:1 \[src\/server\/Combat\.luau:1\]: x{1970}…$/);

    const failures = result.failures as string[];
    expect(failures).toHaveLength(50);
    expect(result.failuresTruncated).toBe(true);
    expect(failures.every((line) => line.length === 2001 && line.endsWith('…'))).toBe(true);

    expect(result.summaries).toHaveLength(50);
    expect(result.summariesTruncated).toBe(true);
    expect(result).toMatchObject({ passed: 70, failed: 0 });
  });

  test('annotates only the error and failure lines it returns', async () => {
    const messages = [
      ...Array.from({ length: 500 }, (_, i) => ({ message: `ServerScriptService.Combat:${i + 1}: boom`, messageType: 'ERROR' })),
      ...Array.from({ length: 500 }, (_, i) => ({ message: `FAIL case ${i}`, messageType: 'OUTPUT' })),
      { message: '0 passed, 500 failed', messageType: 'OUTPUT' },
    ];
    mockFetch((call) => {
      if (call.method === 'POST') return { body: { path: TASK, state: 'COMPLETE', output: { results: [] } } };
      return { body: { luauExecutionSessionTaskLogs: [{ structuredMessages: messages }] } };
    });
    const annotate = jest.spyOn(sourcemaps, 'annotateText');
    const result = await runCloudLuau(
      { script: 'return 1', universe_id: 10, place_id: 20, max_log_lines: 10 },
      { studioPlace: noStudio, ...FAST },
    );
    expect(result).toMatchObject({ failed: 500, errorsTruncated: true, failuresTruncated: true });
    expect(annotate).toHaveBeenCalledTimes(10 + 20 + 50);
  });

  test('cuts a long task error message and log line', async () => {
    mockFetch((call) => {
      if (call.method === 'POST') return { body: { path: TASK, state: 'FAILED', error: { code: 'SCRIPT_ERROR', message: 'e'.repeat(10_000) } } };
      return { body: { luauExecutionSessionTaskLogs: [{ messages: ['l'.repeat(10_000)] }] } };
    });
    const result = await runCloudLuau({ script: 'error()', universe_id: 10, place_id: 20 }, { studioPlace: noStudio, ...FAST });
    expect(result.error).toEqual({ code: 'SCRIPT_ERROR', message: `${'e'.repeat(2000)}…` });
    expect(result.logs).toEqual([`${'l'.repeat(2000)}…`]);
  });

  test('refuses a create reply with an unexpected path, and does not retry a rate limited create', async () => {
    let calls = mockFetch(() => ({ body: { path: 'universes/10/places/20/data-stores/x', state: 'QUEUED' } }));
    await expect(runCloudLuau({ script: 'return 1', universe_id: 10, place_id: 20 }, { studioPlace: noStudio, ...FAST }))
      .rejects.toThrow(/unexpected task/);
    expect(calls).toHaveLength(1);

    jest.restoreAllMocks();
    calls = mockFetch(() => ({ status: 429, body: 'Too many requests' }));
    await expect(runCloudLuau({ script: 'return 1', universe_id: 10, place_id: 20 }, { studioPlace: noStudio, ...FAST }))
      .rejects.toThrow(/Creating the task failed with HTTP 429 \(rate limited/);
    expect(calls).toHaveLength(1);
  });

  test('the handler routes the Studio lookup through body.instance_id', async () => {
    const { host, seen } = fakeHost({ gameId: 10, placeId: 20 });
    mockFetch((call) => {
      if (call.method === 'POST') return { body: { path: TASK, state: 'COMPLETE', output: { results: [42] } } };
      return { body: { luauExecutionSessionTaskLogs: [] } };
    });
    const tools = { forkHost: host } as unknown as RobloxStudioTools;
    const reply = await cloudFeature.handlers.cloud_luau(tools, { script: 'return 42', instance_id: 'inst-2' });
    expect(JSON.parse(reply.content[0].text!)).toMatchObject({ state: 'COMPLETE', results: [42] });
    expect(seen[0]).toEqual({ target: 'edit', instanceId: 'inst-2' });
  });

  test('a routing failure keeps its topology and suggests passing the IDs', async () => {
    const routing = { code: 'multiple_instances_connected' as const, message: 'Several Studio instances are connected.', data: { instances: [], multiplayerGroups: [], count: 2 } };
    const host = {
      peerTargets: async () => {
        throw new RoutingFailure(routing);
      },
    } as unknown as ForkHost;
    const error = await studioPlace(host, undefined).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RoutingFailure);
    expect((error as RoutingFailure).routingError).toMatchObject({ code: 'multiple_instances_connected', data: { count: 2 } });
    expect((error as Error).message).toContain('Pass universe_id and place_id');
  });
});

const compiler = spawnSync('luau-compile', ['--help']).error ? undefined : 'luau-compile';

(compiler ? test : test.skip)('the Studio place lookup compiles as Luau', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fork-cloud-luau-')), 'placeIds.luau');
  fs.writeFileSync(file, PLACE_IDS_LUAU);
  const result = spawnSync(compiler!, ['--null', file], { encoding: 'utf8' });
  expect(result.stderr + result.stdout).not.toMatch(/error/i);
  expect(result.status).toBe(0);
});
