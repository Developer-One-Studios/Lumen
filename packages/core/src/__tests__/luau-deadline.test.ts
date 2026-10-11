import { BridgeService } from '../bridge-service.js';
import { RobloxStudioTools } from '../tools/index.js';

class DeadlineTestBridge extends BridgeService {
  protected override notifyPeerRegistered(): void {
    // Simulated topology must not mutate the local managed-Studio registry.
  }
}

describe('Luau deadlines', () => {
  let bridge: BridgeService;
  let tools: RobloxStudioTools;
  beforeEach(() => {
    jest.useFakeTimers();
    bridge = new DeadlineTestBridge();
    tools = new RobloxStudioTools(bridge);
    for (const role of ['edit', 'server']) {
      expect(bridge.registerPeer({
        peerId: role, transportPeerId: role, instanceId: 'instance:deadline',
        role, placeId: 0, placeName: 'Deadline',
      }).ok).toBe(true);
    }
  });
  afterEach(() => {
    bridge.clearAllPendingRequests();
    jest.useRealTimers();
  });

  test.each([
    [undefined, 25],
    [2, 2],
    [0, 1],
    [1000, 300],
    ['10', 25],
  ])('execute_luau with timeout_s %p asks the plugin to cancel at %ps and waits 5s longer', async (timeout, deadline) => {
    const call = tools.executeLuau('workspace:WaitForChild("Never")', 'edit', 'instance:deadline', undefined, timeout);
    const failed = expect(call).rejects.toThrow();
    const delivery = bridge.claimNextRequestForTransport('edit', 'socket');
    expect(delivery?.data).toEqual({ code: 'workspace:WaitForChild("Never")', timeout_s: deadline });
    expect(delivery?.remainingMs).toBe((deadline + 5) * 1000);
    await jest.advanceTimersByTimeAsync((deadline + 5) * 1000);
    await failed;
  });

  test('eval_server_runtime sends the deadline too', async () => {
    const call = tools.evalServerRuntime('return 1', 'instance:deadline', 3);
    const delivery = bridge.claimNextRequestForTransport('server', 'socket');
    expect(delivery?.data).toEqual({ code: 'return 1', timeout_s: 3 });
    expect(bridge.settleTransportResponse('server', delivery!.requestId, { bridge: 'ok', ok: true, result: '1' })).toBe('accepted');
    expect(JSON.parse((await call).content[0].text)).toMatchObject({ ok: true, result: '1' });
  });
});
