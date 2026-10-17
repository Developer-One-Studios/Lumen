// A server sandboxed in its own PID namespace sees and signals none of the host's processes, and a launcher such as
// Vinegar runs Studio inside a Flatpak with a PID namespace of its own. ROBLOX_STUDIO_LAUNCH_BROKER names the Unix
// socket of a broker on the host that launches, lists and stops Studio for the server. A connection carries one JSON
// request line and gets one JSON reply line back, then the broker closes it.
import * as net from 'net';
import type { StudioProcessAdapter, StudioProcessInfo } from './studio-instance-manager.js';

export const STUDIO_BROKER_EXE = 'RobloxStudioBeta.exe';
const REQUEST_TIMEOUT_MS = 15000;
// The launcher may install a Studio update before Studio starts. Stays below the 3-minute launch completion timeout.
const LAUNCH_TIMEOUT_MS = 150000;
const MAX_REPLY_BYTES = 1024 * 1024;

type BrokerReply = Record<string, unknown>;

export function requestStudioBroker(
  socketPath: string,
  request: { op: string } & Record<string, unknown>,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<BrokerReply> {
  const { promise, resolve, reject } = Promise.withResolvers<BrokerReply>();
  const socket = net.createConnection(socketPath);
  const chunks: Buffer[] = [];
  let size = 0;
  let settled = false;
  const settle = (error: Error | undefined, reply?: BrokerReply) => {
    if (settled) return;
    settled = true;
    socket.destroy();
    if (error) reject(error);
    else resolve(reply as BrokerReply);
  };
  socket.setTimeout(timeoutMs, () => {
    settle(new Error(`The Studio launch broker did not answer ${request.op} within ${timeoutMs} ms.`));
  });
  // Not end(): a Windows named pipe cannot be half closed, so ending here would drop the reply.
  socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
  socket.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_REPLY_BYTES) settle(new Error('The Studio launch broker sent a reply over 1 MB.'));
    else chunks.push(chunk);
  });
  socket.on('error', (error) => {
    settle(new Error(`Could not reach the Studio launch broker at ${socketPath}: ${error.message}`));
  });
  socket.on('end', () => {
    let reply: unknown;
    try {
      reply = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      settle(new Error('The Studio launch broker sent a malformed reply.'));
      return;
    }
    if (reply === null || typeof reply !== 'object' || Array.isArray(reply)) {
      settle(new Error('The Studio launch broker sent a malformed reply.'));
      return;
    }
    const body = reply as BrokerReply;
    if (body.ok !== true) {
      settle(new Error(typeof body.error === 'string' && body.error
        ? body.error
        : `The Studio launch broker refused ${request.op}.`));
      return;
    }
    settle(undefined, body);
  });
  return promise;
}

function toProcessInfo(value: unknown): StudioProcessInfo {
  const proc = (value ?? {}) as Record<string, unknown>;
  const pid = proc.pid;
  const startedAt = proc.startedAt;
  if (
    typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0 ||
    typeof startedAt !== 'string' || !/^[1-9]\d*$/u.test(startedAt)
  ) {
    throw new Error('The Studio launch broker sent a process without a valid pid and startedAt.');
  }
  return {
    Id: pid,
    Name: 'RobloxStudioBeta',
    Path: typeof proc.path === 'string' ? proc.path : undefined,
    MainWindowTitle: '',
    CommandLine: typeof proc.commandLine === 'string' ? proc.commandLine : undefined,
    StartTimeUtcFileTime: startedAt,
  };
}

export function studioLaunchBrokerAdapter(socketPath: string): StudioProcessAdapter {
  const stop = async (pid: number, startedAt?: string): Promise<void> => {
    if (startedAt === undefined) {
      throw new Error('Cannot stop a Studio process through the launch broker without its start time.');
    }
    await requestStudioBroker(socketPath, { op: 'stop', pid, startedAt });
  };
  return {
    // The broker picks the Studio build, so this only labels the launch record.
    resolveStudioExe: () => STUDIO_BROKER_EXE,
    spawnStudio: async (exe, args, options) => {
      if (exe !== STUDIO_BROKER_EXE || options?.env) {
        throw new Error(
          'studio_executable and process_environment are unavailable when Studio launches through ROBLOX_STUDIO_LAUNCH_BROKER.',
        );
      }
      const reply = await requestStudioBroker(socketPath, { op: 'launch', args }, LAUNCH_TIMEOUT_MS);
      const studio = toProcessInfo(reply.process);
      // No authorize or release: the broker cannot hold Studio suspended, so require_process_identity is refused
      // after the launch and abort stops the Studio it started.
      return {
        pid: studio.Id,
        nativePid: studio.Id,
        nativeStartedAt: studio.StartTimeUtcFileTime,
        unref() {},
        abort: () => stop(studio.Id, studio.StartTimeUtcFileTime),
      };
    },
    listStudioProcesses: async () => {
      const reply = await requestStudioBroker(socketPath, { op: 'list' });
      if (!Array.isArray(reply.processes)) {
        throw new Error('The Studio launch broker sent a malformed process list.');
      }
      return reply.processes.map(toProcessInfo);
    },
    stopProcess: stop,
  };
}

export function studioLaunchBrokerFromEnv(env: NodeJS.ProcessEnv = process.env): StudioProcessAdapter | undefined {
  const socketPath = env.ROBLOX_STUDIO_LAUNCH_BROKER?.trim();
  return socketPath ? studioLaunchBrokerAdapter(socketPath) : undefined;
}
