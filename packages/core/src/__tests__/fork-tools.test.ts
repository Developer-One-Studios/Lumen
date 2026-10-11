import { ForkTools, fetchAssetDetails, luauValue, type ForkHost, type PeerTarget } from '../tools/fork-tools.js';

type Call = { endpoint: string; code: string; peerId: string };

function text(body: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(body) }] };
}

function fakeHost(peers: PeerTarget[], reply: (call: Call) => unknown, extra: Partial<ForkHost> = {}) {
  const calls: Call[] = [];
  const host: ForkHost = {
    peerTargets: async (target) => {
      if (target === undefined || target === 'all') return peers;
      return peers.filter((peer) => peer.role === target);
    },
    requestPeer: async (endpoint, data, peerId) => {
      const call = { endpoint, code: (data as { code?: string }).code ?? '', peerId };
      calls.push(call);
      return reply(call);
    },
    soloPlaytest: async () => text({ success: true }),
    getRuntimeLogs: async () => text({ entries: [] }),
    ...extra,
  };
  return { host, calls };
}

const ok = (value: unknown) => ({ success: true, returnValue: JSON.stringify(value) });
const body = (result: { content: Array<{ text?: string }> }) => JSON.parse(result.content[0].text!);

describe('fork tool plumbing', () => {
  test('unwraps execute and eval replies and surfaces snippet errors', () => {
    expect(luauValue(ok({ a: 1 }))).toEqual({ a: 1 });
    expect(luauValue({ success: true, result: '{"b":2}' })).toEqual({ b: 2 });
    expect(() => luauValue(ok({ error: 'root not found' }))).toThrow('root not found');
    expect(() => luauValue({ success: false, error: 'boom' })).toThrow('boom');
    expect(() => luauValue({ success: true, returnValue: 'table: 0x1' })).toThrow(/non-JSON/);
  });

  test('perf_stats samples every peer in parallel and keeps per-peer failures', async () => {
    const peers = [{ role: 'edit', peerId: 'e' }, { role: 'server', peerId: 's' }, { role: 'client-1', peerId: 'c' }];
    const { host, calls } = fakeHost(peers, (call) => {
      if (call.peerId === 'c') return { success: false, error: 'client gone' };
      return ok({ heartbeatHz: 60, metrics: { FrameTimeMs: { avg: 16.7, p95: 18, max: 20 } } });
    });
    const result = body(await new ForkTools(host).perfStats({ duration_ms: 500 }));
    expect(calls).toHaveLength(3);
    expect(calls[0].code).toContain('"duration_ms":500');
    expect(result.server.heartbeatHz).toBe(60);
    expect(result['client-1']).toEqual({ error: 'client gone' });
  });

  test('profile_toggle refuses the edit peer so nothing is saved into the place', async () => {
    const { host } = fakeHost([{ role: 'edit', peerId: 'e' }], () => ok({}));
    await expect(new ForkTools(host).profileToggle({ category: 'particles', target: 'edit' })).rejects.toThrow(/never edit/);
    await expect(new ForkTools(host).profileToggle({ category: 'instance', target: 'edit' })).rejects.toThrow(/needs path/);
  });

  test('leak_check reports only steady growth after the warm-up round', async () => {
    let round = 0;
    const { host, calls } = fakeHost([{ role: 'server', peerId: 's' }], (call) => {
      if (call.endpoint === '/api/eval-runtime' && call.code.startsWith('local values')) {
        return { success: true, result: JSON.stringify({ 1: round * 10 }) };
      }
      if (call.endpoint === '/api/eval-runtime') {
        round += 1;
        return { success: true };
      }
      return ok({
        totalMb: 100 + round * 2,
        instanceCount: 5000,
        tags: { LuaHeap: 40 + round, Signals: 3 },
        classes: { Part: 100, RBXScriptSignal: round > 2 ? round * 20 : 0, Folder: round % 2 === 0 ? 5 : 9 },
      });
    });
    const result = body(await new ForkTools(host).leakCheck({
      action: 'spawnEnemy()', iterations: 5, settle_ms: 0, watch: ['#cache.entries'],
    }));
    const metrics = result.growing.map((row: { metric: string }) => row.metric);
    expect(metrics).toEqual(expect.arrayContaining(['totalMb', 'tag:LuaHeap', 'class:RBXScriptSignal', 'watch:#cache.entries']));
    expect(metrics).not.toContain('class:Part');
    expect(metrics).not.toContain('class:Folder');
    expect(metrics).not.toContain('tag:Signals');
    expect(result.measuredRounds).toBe(4);
    expect(calls.filter((call) => call.code === 'spawnEnemy()')).toHaveLength(5);
    expect(calls.find((call) => call.code.startsWith('local values'))!.code).toContain('return (#cache.entries)');
  });

  test('replication_diff flags values that differ beyond tolerance and missing instances', async () => {
    const peers = [{ role: 'server', peerId: 's' }, { role: 'client-1', peerId: 'c1' }, { role: 'client-2', peerId: 'c2' }];
    const { host } = fakeHost([{ role: 'edit', peerId: 'e' }, ...peers], (call) => {
      if (call.peerId === 's') return ok({ exists: true, properties: { Position: [0, 5, 0], Anchored: false }, attributes: { Team: 'Red' }, networkOwner: 'server' });
      if (call.peerId === 'c1') return ok({ exists: true, properties: { Position: [0, 5.02, 0], Anchored: false }, attributes: { Team: 'Blue' } });
      return ok({ exists: false });
    });
    const result = body(await new ForkTools(host).replicationDiff({ path: 'game.Workspace.Flag' }));
    expect(result.inSync).toBe(false);
    expect(result.exists).toEqual({ server: true, 'client-1': true, 'client-2': false });
    expect(result.differences['@Team']).toEqual({ server: 'Red', 'client-1': 'Blue', 'client-2': null });
    expect(result.differences.Position).toEqual({ server: [0, 5, 0], 'client-1': [0, 5.02, 0], 'client-2': null });
    expect(result.networkOwner).toBe('server');
  });

  test('fuzz_remotes attributes new server errors to the remote that caused them', async () => {
    let since = 10;
    const peers = [{ role: 'server', peerId: 's' }, { role: 'client-1', peerId: 'c' }];
    let current = '';
    const { host } = fakeHost(peers, (call) => {
      if (call.endpoint === '/api/get-runtime-logs') {
        const entries = current === 'game.ReplicatedStorage.Buy'
          ? [{ level: 'ERR', message: 'ServerScriptService.Shop:12: attempt to compare number < nil' }]
          : [];
        current = '';
        since += entries.length;
        return { entries, nextSince: since };
      }
      if (call.code.includes('remotes = remotes')) return ok({ remotes: ['game.ReplicatedStorage.Buy', 'game.ReplicatedStorage.Ping'] });
      current = /"path":"([^"]+)"/.exec(call.code)![1];
      return ok({ remote: current, fired: 71, clientErrors: [], kicked: false });
    });
    const result = body(await new ForkTools(host).fuzzRemotes({ settle_ms: 100 }));
    expect(result.fuzzed).toBe(2);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].remote).toBe('game.ReplicatedStorage.Buy');
    expect(result.findings[0].serverErrors[0]).toContain('attempt to compare');
    expect(result.clean).toEqual(['game.ReplicatedStorage.Ping']);
  });

  test('run_tests waits for every runner summary, collects failures, then stops', async () => {
    const started = Date.now() / 1000;
    const actions: string[] = [];
    const cursors: Array<string | undefined> = [];
    const { host } = fakeHost([{ role: 'edit', peerId: 'e' }], () => ok({}), {
      soloPlaytest: async (action) => {
        actions.push(action);
        return text({ success: true });
      },
      // Like the real buffer: a cursor only returns lines logged after it.
      getRuntimeLogs: async (_instanceId, cursor) => {
        cursors.push(cursor);
        if (cursor === undefined) {
          return text({
            nextCursor: 'after-first',
            entries: [
              { ts: started - 100, level: 'OUT', message: '[Test] 9 passed, 0 failed' },
              { ts: started + 1, level: 'OUT', message: '[Test] PASS  damage applies' },
              { ts: started + 1, level: 'WARN', message: '[Test] FAIL  shield blocks: expected 0, got 5' },
              { ts: started + 1, level: 'OUT', message: '[Test] 1 passed, 1 failed' },
            ],
          });
        }
        return text({ nextCursor: 'after-second', entries: [{ ts: started + 2, level: 'OUT', message: '[Test] 3 passed, 0 failed' }] });
      },
    });
    const result = body(await new ForkTools(host).runTests({ expected_summaries: 2, timeout_s: 5 }));
    expect(result.completed).toBe(true);
    expect(result.passed).toBe(4);
    expect(result.failed).toBe(1);
    expect(result.failures).toEqual(['shield blocks: expected 0, got 5']);
    expect(actions).toEqual(['start', 'stop']);
    expect(cursors).toEqual([undefined, 'after-first']);
  });

  test('leak_check stops when the action fails in the game VM', async () => {
    const { host } = fakeHost([{ role: 'server', peerId: 's' }], (call) => {
      if (call.endpoint === '/api/eval-runtime') return { bridge: 'ok', ok: false, error: 'attempt to call a nil value' };
      return ok({ totalMb: 1, instanceCount: 1, tags: {}, classes: {} });
    });
    await expect(new ForkTools(host).leakCheck({ action: 'nope()', iterations: 2, settle_ms: 0 }))
      .rejects.toThrow(/iteration 1: attempt to call a nil value/);
  });

  test('asset lookups separate missing assets from rate limits', async () => {
    const statuses = [429, 200, 404, 503, 503];
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      const status = statuses.shift()!;
      return new Response(status === 200 ? JSON.stringify({ Creator: { Id: 7 } }) : 'x', { status });
    });
    try {
      expect(await fetchAssetDetails(1, 2, 0)).toEqual({ details: { Creator: { Id: 7 } } });
      expect(await fetchAssetDetails(2, 2, 0)).toEqual({ error: 'HTTP 404', notFound: true });
      expect(await fetchAssetDetails(3, 2, 0)).toEqual({ error: 'HTTP 503', notFound: false });
    } finally {
      fetchMock.mockRestore();
    }
  });

  test('multi_edit validates edits and creates through the edit peer', async () => {
    const { host, calls } = fakeHost([{ role: 'edit', peerId: 'e' }], () => ok({ path: 'game.ServerScriptService.New', created: true }));
    const tools = new ForkTools(host);
    await expect(tools.multiEdit({ path: 'game.ServerScriptService.New', edits: [] })).rejects.toThrow(/non-empty/);
    await expect(tools.multiEdit({ path: 'game.ServerScriptService.New', edits: [{ old_string: 'a' }] })).rejects.toThrow(/edit 1/);
    const result = body(await tools.multiEdit({
      path: 'game.ServerScriptService.New', class_name: 'Script', edits: [{ old_string: '', new_string: 'print("hi")' }],
    }));
    expect(result.created).toBe(true);
    expect(calls[0].code).toContain('"parent_path":"game.ServerScriptService","name":"New"');
  });
});
