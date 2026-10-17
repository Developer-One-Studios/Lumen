import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { StudioInstanceManager } from '../studio-instance-manager.js';
import {
  STUDIO_BROKER_EXE,
  requestStudioBroker,
  studioLaunchBrokerAdapter,
  studioLaunchBrokerFromEnv,
} from '../studio-launch-broker.js';

interface FakeProcess {
  pid: number;
  startedAt: string;
  path: string;
}

const STUDIO: FakeProcess = {
  pid: 4242,
  startedAt: '134050000000000000',
  path: 'Z:\\home\\user\\versions\\version-1\\RobloxStudioBeta.exe',
};

// One JSON request line in, one JSON reply line out, like the host broker.
function startFakeBroker(socketPath: string, reply: (request: Record<string, unknown>) => unknown): Promise<net.Server> {
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => { buffer += chunk; });
    socket.on('end', () => {
      socket.end(`${JSON.stringify(reply(JSON.parse(buffer)))}\n`);
    });
  });
  const { promise, resolve } = Promise.withResolvers<net.Server>();
  server.listen(socketPath, () => resolve(server));
  return promise;
}

describe('Studio launch broker adapter', () => {
  let dir: string;
  let socketPath: string;
  let server: net.Server | undefined;
  let requests: Record<string, unknown>[];
  let processes: FakeProcess[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-launch-broker-'));
    socketPath = path.join(dir, 'broker.sock');
    requests = [];
    processes = [];
  });

  afterEach(async () => {
    if (server) {
      const { promise, resolve } = Promise.withResolvers<void>();
      server.close(() => resolve());
      await promise;
      server = undefined;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function serveStudio(): Promise<net.Server> {
    return startFakeBroker(socketPath, (request) => {
      requests.push(request);
      switch (request.op) {
        case 'launch':
          processes = [STUDIO];
          return { ok: true, process: STUDIO };
        case 'list':
          return { ok: true, processes };
        case 'stop':
          processes = processes.filter((proc) => proc.pid !== request.pid || proc.startedAt !== request.startedAt);
          return { ok: true };
        default:
          return { ok: false, error: `unknown op ${String(request.op)}` };
      }
    });
  }

  test('launches, observes and closes Studio through the broker', async () => {
    server = await serveStudio();
    const manager = new StudioInstanceManager({
      registryDir: path.join(dir, 'registry'),
      processAdapter: studioLaunchBrokerAdapter(socketPath),
    });

    const record = await manager.launch({ source: 'published_place', placeId: 11, universeId: 22 });

    expect(requests[requests.length - 1]).toEqual({
      op: 'launch',
      args: ['--task', 'EditPlace', '--placeId', '11', '--universeId', '22'],
    });
    expect(record).toMatchObject({
      exe: STUDIO_BROKER_EXE,
      nativeProcessId: STUDIO.pid,
      nativeProcessStartedAt: STUDIO.startedAt,
      state: 'launching',
    });
    expect(manager.getLifecycleCapabilities().processIdentity).toEqual({ supported: true, launcher: 'custom-adapter' });

    await manager.refresh(record);
    expect(record.processObservationStatus).toBe('running');

    await expect(manager.close(record)).resolves.toMatchObject({ status: 'closed' });
    expect(requests).toContainEqual({ op: 'stop', pid: STUDIO.pid, startedAt: STUDIO.startedAt });
    expect(processes).toEqual([]);
  });

  test('reports the broker refusal as the launch error', async () => {
    server = await startFakeBroker(socketPath, () => ({ ok: false, error: 'Vinegar exited (code 1) before Studio started.' }));
    const manager = new StudioInstanceManager({
      registryDir: path.join(dir, 'registry'),
      processAdapter: studioLaunchBrokerAdapter(socketPath),
    });

    await expect(manager.launch({ source: 'published_place', placeId: 11, universeId: 22 }))
      .rejects.toThrow('Vinegar exited (code 1) before Studio started.');
  });

  test('refuses a launch that picks its own executable or environment', async () => {
    server = await serveStudio();
    const adapter = studioLaunchBrokerAdapter(socketPath);

    await expect(adapter.spawnStudio!('/usr/bin/other', [], {})).rejects.toThrow('studio_executable');
    await expect(adapter.spawnStudio!(STUDIO_BROKER_EXE, [], { env: { WINEPREFIX: '/tmp' } }))
      .rejects.toThrow('process_environment');
    expect(requests).toEqual([]);
  });

  test('rejects a process without an exact identity', async () => {
    server = await startFakeBroker(socketPath, () => ({ ok: true, processes: [{ pid: 7, startedAt: 'soon' }] }));

    await expect(studioLaunchBrokerAdapter(socketPath).listStudioProcesses!()).rejects.toThrow('valid pid and startedAt');
  });

  test('names the socket when the broker is unreachable', async () => {
    await expect(requestStudioBroker(socketPath, { op: 'list' })).rejects.toThrow(socketPath);
  });

  test('is configured only by ROBLOX_STUDIO_LAUNCH_BROKER', () => {
    expect(studioLaunchBrokerFromEnv({})).toBeUndefined();
    expect(studioLaunchBrokerFromEnv({ ROBLOX_STUDIO_LAUNCH_BROKER: ' ' })).toBeUndefined();
    expect(studioLaunchBrokerFromEnv({ ROBLOX_STUDIO_LAUNCH_BROKER: socketPath })?.spawnStudio).toBeDefined();
  });
});
