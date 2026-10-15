import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { BridgeService } from '../bridge-service.js';
import { StudioInstanceManager } from '../studio-instance-manager.js';
import { RobloxStudioTools } from '../tools/index.js';
import { StudioHttpClient } from '../tools/studio-client.js';
import {
  buildContactSheet,
  hostWindowFrameSource,
  openX11FrameSource,
  recordFrames,
  shrinkFrame,
  spreadIndices,
  timeLabel,
  type FrameSource,
  type SourceFrame,
} from '../viewport-recorder.js';
import {
  X11Connection,
  displaySocket,
  findXauthCookie,
  listTopLevelWindows,
  parseSetup,
  pixelLayout,
  toRgbaInPlace,
} from '../x11-client.js';

const COOKIE = Buffer.from('0123456789abcdef');

function xauthEntry(number: string, cookie: Buffer): Buffer {
  const field = (value: Buffer) => Buffer.concat([Buffer.from([value.length >> 8, value.length & 0xff]), value]);
  return Buffer.concat([Buffer.from([1, 0]), field(Buffer.from('host')), field(Buffer.from(number)), field(Buffer.from('MIT-MAGIC-COOKIE-1')), field(cookie)]);
}

// The setup reply body of an X server with one screen (root 0x100) and one 24 bit TrueColor visual (0x21), BGRX in memory.
function setupBody(): Buffer {
  const body = Buffer.alloc(116);
  body.writeUInt16LE(4, 16);
  body.writeUInt16LE(0xffff, 18);
  body[20] = 1;
  body[21] = 1;
  body[22] = 0;
  body.write('Fake', 32, 'latin1');
  body[36] = 24;
  body[37] = 32;
  body[38] = 32;
  body.writeUInt32LE(0x100, 44);
  body.writeUInt32LE(0x21, 76);
  body[82] = 24;
  body[83] = 1;
  body[84] = 24;
  body.writeUInt16LE(1, 86);
  body.writeUInt32LE(0x21, 92);
  body[96] = 4;
  body.writeUInt32LE(0xff0000, 100);
  body.writeUInt32LE(0x00ff00, 104);
  body.writeUInt32LE(0x0000ff, 108);
  return body;
}

const STUDIO = 0x300;
const OTHER = 0x301;
const NET_WM_NAME = 0x200;

// Enough of an X server for the recorder: setup with a cookie, the five requests it makes, an unasked-for event before
// every image, and BadMatch for an image of a minimized window. Pixel (x, y) is red x, green y, blue 7.
let fakeServers = 0;

// Node listens on local sockets only through named pipes on Windows, and on Unix sockets everywhere else.
function localSocketPath(): string {
  if (process.platform === 'win32') return `\\\\.\\pipe\\lumen-fake-x-${process.pid}-${++fakeServers}`;
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fake-x-')), 'X99');
}

function fakeXServer(state: { mapped: boolean; requests: number[] }) {
  const socketPath = localSocketPath();
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let setUp = false;
    let sequence = 0;
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (!setUp) {
          if (buffer.length < 12) return;
          const nameLength = buffer.readUInt16LE(6);
          const dataLength = buffer.readUInt16LE(8);
          const total = 12 + nameLength + ((4 - (nameLength % 4)) % 4) + dataLength + ((4 - (dataLength % 4)) % 4);
          if (buffer.length < total) return;
          const cookieStart = 12 + nameLength + ((4 - (nameLength % 4)) % 4);
          const accepted = buffer.subarray(cookieStart, cookieStart + dataLength).equals(COOKIE);
          buffer = buffer.subarray(total);
          setUp = true;
          if (!accepted) {
            const reason = Buffer.from('bad cookie');
            const head = Buffer.alloc(8);
            head[0] = 0;
            head[1] = reason.length;
            head.writeUInt16LE(Math.ceil(reason.length / 4), 6);
            socket.write(Buffer.concat([head, reason, Buffer.alloc((4 - (reason.length % 4)) % 4)]));
            socket.end();
            return;
          }
          const body = setupBody();
          const head = Buffer.alloc(8);
          head[0] = 1;
          head.writeUInt16LE(11, 2);
          head.writeUInt16LE(body.length / 4, 6);
          socket.write(Buffer.concat([head, body]));
          continue;
        }
        if (buffer.length < 4) return;
        const length = buffer.readUInt16LE(2) * 4;
        if (buffer.length < length) return;
        const request = buffer.subarray(0, length);
        buffer = buffer.subarray(length);
        sequence++;
        state.requests.push(request[0]);
        socket.write(answer(request, sequence, state));
      }
    });
  });
  return new Promise<{ socketPath: string; close: () => void }>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve({ socketPath, close: () => server.close() }));
  });
}

function reply(sequence: number, data: number, fields: Buffer, extra: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(32);
  head[0] = 1;
  head[1] = data;
  head.writeUInt16LE(sequence, 2);
  head.writeUInt32LE(extra.length / 4, 4);
  fields.copy(head, 8);
  return Buffer.concat([head, extra]);
}

function padded(value: Buffer): Buffer {
  return Buffer.concat([value, Buffer.alloc((4 - (value.length % 4)) % 4)]);
}

function answer(request: Buffer, sequence: number, state: { mapped: boolean }): Buffer {
  const opcode = request[0];
  if (opcode === 16) return reply(sequence, 0, Buffer.from(new Uint32Array([NET_WM_NAME]).buffer));
  if (opcode === 15) {
    const fields = Buffer.alloc(24);
    fields.writeUInt16LE(2, 8);
    return reply(sequence, 0, fields, Buffer.from(new Uint32Array([STUDIO, OTHER]).buffer));
  }
  if (opcode === 20) {
    const window = request.readUInt32LE(4);
    const property = request.readUInt32LE(8);
    const values: Record<string, string> = {
      [`${STUDIO}:${NET_WM_NAME}`]: 'Arena - Roblox Studio',
      [`${STUDIO}:67`]: 'steam_proton\0steam_proton\0',
      [`${OTHER}:39`]: 'Terminal',
      [`${OTHER}:67`]: 'term\0Term\0',
    };
    const value = values[`${window}:${property}`];
    const fields = Buffer.alloc(24);
    if (value === undefined) return reply(sequence, 0, fields);
    fields.writeUInt32LE(property === 67 || property === 39 ? 31 : 0x201, 0);
    fields.writeUInt32LE(Buffer.byteLength(value, 'utf8'), 8);
    return reply(sequence, 8, fields, padded(Buffer.from(value, 'utf8')));
  }
  if (opcode === 14) {
    const fields = Buffer.alloc(24);
    const studio = request.readUInt32LE(4) === STUDIO;
    fields.writeUInt16LE(studio ? 400 : 300, 8);
    fields.writeUInt16LE(studio ? 200 : 300, 10);
    return reply(sequence, 24, fields);
  }
  if (opcode === 3) {
    const fields = Buffer.alloc(24);
    fields[18] = state.mapped ? 2 : 0;
    return reply(sequence, 0, fields, Buffer.alloc(12));
  }
  if (opcode === 73) {
    if (!state.mapped) {
      const error = Buffer.alloc(32);
      error[1] = 8;
      error.writeUInt16LE(sequence, 2);
      error[10] = 73;
      return error;
    }
    const x0 = request.readInt16LE(8);
    const y0 = request.readInt16LE(10);
    const width = request.readUInt16LE(12);
    const height = request.readUInt16LE(14);
    const pixels = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4;
        pixels[offset] = 7;
        pixels[offset + 1] = (y0 + y) & 0xff;
        pixels[offset + 2] = (x0 + x) & 0xff;
      }
    }
    const fields = Buffer.alloc(24);
    fields.writeUInt32LE(0x21, 0);
    const expose = Buffer.alloc(32);
    expose[0] = 12;
    return Buffer.concat([expose, reply(sequence, 24, fields, pixels)]);
  }
  throw new Error(`fake X server got opcode ${opcode}`);
}

function xEnvironment(): NodeJS.ProcessEnv {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xauth-')), 'Xauthority');
  fs.writeFileSync(file, Buffer.concat([xauthEntry('7', Buffer.from('other-display')), xauthEntry('99', COOKIE)]));
  return { DISPLAY: ':99', XAUTHORITY: file };
}

describe('X11 client', () => {
  test('local displays map to their socket and remote ones are refused', () => {
    expect(displaySocket(':0')).toEqual({ path: '/tmp/.X11-unix/X0', number: '0' });
    expect(displaySocket('unix:1.0')).toEqual({ path: '/tmp/.X11-unix/X1', number: '1' });
    expect(displaySocket('remote:0')).toBeUndefined();
    expect(displaySocket(undefined)).toBeUndefined();
  });

  test('the cookie is picked by display number and a truncated file yields none', () => {
    const file = Buffer.concat([xauthEntry('7', Buffer.from('seven')), xauthEntry('99', COOKIE)]);
    expect(findXauthCookie(file, '99')).toEqual(COOKIE);
    expect(findXauthCookie(file, '3')).toBeUndefined();
    expect(findXauthCookie(file.subarray(0, file.length - 3), '99')).toBeUndefined();
  });

  test('setup parsing finds the root, pixel formats and visual masks', () => {
    const setup = parseSetup(setupBody());
    expect(setup.root).toBe(0x100);
    expect(setup.lsbFirst).toBe(true);
    expect(setup.bitsPerPixel.get(24)).toBe(32);
    const visual = setup.visuals.get(0x21)!;
    expect(pixelLayout(visual, true)).toEqual({ r: 2, g: 1, b: 0 });
    expect(pixelLayout(visual, false)).toEqual({ r: 1, g: 2, b: 3 });
    expect(toRgbaInPlace(Buffer.from([1, 2, 3, 0]), { r: 2, g: 1, b: 0 })).toEqual(Buffer.from([3, 2, 1, 255]));
  });

  test('talks to an X server: windows, images in RGBA, and unasked-for events skipped', async () => {
    const state = { mapped: true, requests: [] as number[] };
    const server = await fakeXServer(state);
    const connection = await X11Connection.open(xEnvironment(), server.socketPath);
    try {
      const windows = await listTopLevelWindows(connection);
      expect(windows).toEqual([
        { id: STUDIO, title: 'Arena - Roblox Studio', className: 'steam_proton steam_proton', width: 400, height: 200 },
        { id: OTHER, title: 'Terminal', className: 'term Term', width: 300, height: 300 },
      ]);
      expect(await connection.mapState(STUDIO)).toBe('viewable');
      const image = await connection.getImage(STUDIO, 10, 20, 2, 1);
      expect(toRgbaInPlace(Buffer.from(image.data), image.layout)).toEqual(Buffer.from([10, 20, 7, 255, 11, 20, 7, 255]));
    } finally {
      connection.close();
      server.close();
    }
  });

  test('a wrong cookie is reported as a refusal', async () => {
    const server = await fakeXServer({ mapped: true, requests: [] });
    const environment = xEnvironment();
    fs.writeFileSync(environment.XAUTHORITY!, xauthEntry('99', Buffer.from('wrong-cookie-xxx')));
    await expect(X11Connection.open(environment, server.socketPath)).rejects.toThrow('refused the connection: bad cookie');
    server.close();
  });
});

describe('X11 frame source', () => {
  test('finds Studio under Proton, grabs the window and a rect, and reports a minimize mid-recording', async () => {
    const state = { mapped: true, requests: [] as number[] };
    const server = await fakeXServer(state);
    const source = await openX11FrameSource('Arena', xEnvironment(), server.socketPath);
    try {
      const window = await source.grabWindow();
      expect([window.width, window.height]).toEqual([400, 200]);
      expect([...window.rgba.subarray((5 * 400 + 3) * 4, (5 * 400 + 3) * 4 + 4)]).toEqual([3, 5, 7, 255]);
      const rect = await source.grabRect({ x: 100, y: 50, width: 4, height: 2 });
      // Each output pixel averages a 2x2 block, rows 50 and 51 included.
      expect(shrinkFrame(rect, 2, 1).rgba).toEqual(Buffer.from([101, 51, 7, 255, 103, 51, 7, 255]));
      state.mapped = false;
      await expect(source.grabRect({ x: 0, y: 0, width: 4, height: 4 })).rejects.toThrow("'Arena - Roblox Studio' is minimized; restore it");
    } finally {
      source.close();
      server.close();
    }
  });

  test('a minimized Studio is refused before anything is read', async () => {
    const state = { mapped: false, requests: [] as number[] };
    const server = await fakeXServer(state);
    await expect(openX11FrameSource(undefined, xEnvironment(), server.socketPath)).rejects.toThrow('is minimized; restore it (it may stay behind other windows)');
    expect(state.requests).not.toContain(73);
    server.close();
  });
});

function sourceFrame(width: number, height: number, value: number): SourceFrame {
  const data = Buffer.alloc(width * height * 4, value);
  return { width, height, data, layout: { r: 0, g: 1, b: 2 } };
}

describe('recording', () => {
  test('grabs on a fixed schedule, marks repeats and counts ticks that fell behind', async () => {
    let clock = 1000;
    const values = [1, 1, 2, 3, 3];
    const grabTimes: number[] = [];
    const source: FrameSource = {
      grabWindow: async () => ({ width: 1, height: 1, rgba: Buffer.alloc(4) }),
      grabRect: async () => {
        grabTimes.push(clock);
        const value = values.shift()!;
        // The third grab is slow, so the fourth tick comes due late.
        if (value === 2) clock += 150;
        return sourceFrame(4, 2, value);
      },
      close: () => undefined,
    };
    const recording = await recordFrames({
      source, rect: { x: 0, y: 0, width: 4, height: 2 }, fps: 10, durationMs: 500, width: 2, height: 1,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    expect(grabTimes).toEqual([1000, 1100, 1200, 1350, 1400]);
    expect(recording.frames.map((frame) => frame.repeat)).toEqual([false, true, false, false, true]);
    expect(recording.frames.map((frame) => frame.offsetMs)).toEqual([0, 100, 200, 350, 400]);
    expect(recording.lateTicks).toBe(1);
    expect(recording.frames[0].frame.rgba).toEqual(Buffer.from([1, 1, 1, 255, 1, 1, 1, 255]));
  });

  test('a failure after the first frame stops early with what was recorded, and one before it throws', async () => {
    let calls = 0;
    const failing = (after: number): FrameSource => ({
      grabWindow: async () => ({ width: 1, height: 1, rgba: Buffer.alloc(4) }),
      grabRect: async () => {
        if (calls++ >= after) throw new Error('window minimized');
        return sourceFrame(2, 2, 9);
      },
      close: () => undefined,
    });
    const options = { rect: { x: 0, y: 0, width: 2, height: 2 }, fps: 30, durationMs: 200, width: 2, height: 2, sleep: async () => undefined };
    const recording = await recordFrames({ ...options, source: failing(2) });
    expect(recording.frames).toHaveLength(2);
    expect(recording.stoppedEarly).toBe('window minimized');
    calls = 0;
    await expect(recordFrames({ ...options, source: failing(0) })).rejects.toThrow('window minimized');
  });

  test('picks for the grid are evenly spaced and keep both ends', () => {
    expect(spreadIndices(3, 5)).toEqual([0, 1, 2]);
    expect(spreadIndices(100, 4)).toEqual([0, 33, 66, 99]);
    expect(spreadIndices(10, 1)).toEqual([0]);
    expect(timeLabel(1234.4)).toBe('1.23s');
  });

  test('the grid tiles frames in order with a dark label box and white digits', () => {
    const tile = (value: number) => ({ frame: { width: 40, height: 20, rgba: Buffer.alloc(40 * 20 * 4, value) }, label: '0.50s' });
    const sheet = buildContactSheet([tile(100), tile(150), tile(200)], 2, 40);
    expect([sheet.width, sheet.height]).toEqual([2 * 40 + 3 * 4, 2 * 20 + 3 * 4]);
    const pixel = (x: number, y: number) => [...sheet.rgba.subarray((y * sheet.width + x) * 4, (y * sheet.width + x) * 4 + 3)];
    expect(pixel(4 + 39, 4 + 19)).toEqual([100, 100, 100]);
    expect(pixel(4 + 40 + 4 + 39, 4 + 19)).toEqual([150, 150, 150]);
    expect(pixel(4 + 39, 4 + 20 + 4 + 19)).toEqual([200, 200, 200]);
    // Label box corner, then the top-left pixel of the first digit, '0'.
    expect(pixel(4, 4)).toEqual([0, 0, 0]);
    expect(pixel(5, 5)).toEqual([255, 255, 255]);
  });

  test('the host window source crops the viewport from each window capture', async () => {
    const width = 6;
    const rgba = Buffer.alloc(width * 4 * 4);
    for (let i = 0; i < width * 4; i++) rgba[i * 4] = i;
    const capture = jest.fn(async () => ({ ok: true as const, capture: { width, height: 4, rgba, title: 'Arena - Roblox Studio' } }));
    const source = hostWindowFrameSource(capture, 'Arena');
    const rect = await source.grabRect({ x: 1, y: 2, width: 2, height: 1 });
    expect([rect.data[0], rect.data[4]]).toEqual([13, 14]);
    await expect(source.grabRect({ x: 5, y: 0, width: 3, height: 1 })).rejects.toThrow('shrank below the recorded viewport');
  });
});

describe('record_viewport', () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    jest.spyOn(StudioInstanceManager.prototype, 'pendingLaunches').mockResolvedValue([]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    Object.defineProperty(process, 'platform', platformDescriptor);
  });

  // A 120x80 window with the viewport at (10, 20), 80x40, and magenta corner markers while they are shown.
  function windowFrame(markers: boolean) {
    const width = 120;
    const height = 80;
    const rgba = Buffer.alloc(width * height * 4, 60);
    for (let y = 20; y < 60; y++) {
      for (let x = 10; x < 90; x++) {
        const offset = (y * width + x) * 4;
        rgba[offset] = 30;
        rgba[offset + 1] = 120;
        rgba[offset + 2] = 200;
        const corner = (x < 14 || x >= 86) && (y < 24 || y >= 56);
        if (markers && corner) {
          rgba[offset] = 255;
          rgba[offset + 1] = 0;
          rgba[offset + 2] = 255;
        }
      }
    }
    return { width, height, rgba };
  }

  function makeTools(source: FrameSource, markerActions: string[], shown: { value: boolean }) {
    const bridge = new BridgeService();
    bridge.registerPeer({ peerId: 'edit-session', transportPeerId: 'edit-session', instanceId: 'instance:test', role: 'edit', placeId: 0, placeName: 'Arena', dataModelName: 'Arena', isRunning: false });
    jest.spyOn(StudioHttpClient.prototype, 'request').mockImplementation((async (endpoint: string, data: { action: string }) => {
      if (endpoint !== '/api/capture-markers') throw new Error(`unexpected ${endpoint}`);
      markerActions.push(data.action);
      if (data.action === 'show') shown.value = true;
      if (data.action === 'hide') shown.value = false;
      return { success: true, captureId: 'capture:1', viewportWidth: 80, viewportHeight: 40, markerSize: 4 };
    }) as never);
    const tools = new RobloxStudioTools(bridge);
    (tools as unknown as { openRecordingSource: () => Promise<FrameSource> }).openRecordingSource = async () => source;
    return tools;
  }

  test('locates the viewport with markers, records clean frames, saves them and returns a timed grid', async () => {
    const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'recording-'));
    jest.replaceProperty(process, 'env', { ...process.env, ROBLOX_STUDIO_HOST_CAPTURE: '1', ROBLOX_MCP_ARTIFACT_DIR: artifacts });
    const markerActions: string[] = [];
    const shown = { value: false };
    const rects: Array<{ x: number; y: number; width: number; height: number }> = [];
    let closed = false;
    const source: FrameSource = {
      grabWindow: async () => windowFrame(shown.value),
      grabRect: async (rect) => {
        rects.push(rect);
        const window = windowFrame(shown.value);
        const data = Buffer.alloc(rect.width * rect.height * 4);
        for (let y = 0; y < rect.height; y++) window.rgba.copy(data, y * rect.width * 4, ((rect.y + y) * window.width + rect.x) * 4, ((rect.y + y) * window.width + rect.x + rect.width) * 4);
        return { width: rect.width, height: rect.height, data, layout: { r: 0, g: 1, b: 2 } };
      },
      close: () => {
        closed = true;
      },
    };
    const tools = makeTools(source, markerActions, shown);

    const result = await tools.recordViewport('instance:test', { duration_s: 0.5, fps: 10, frame_width: 64, sheet_frames: 4 });
    const summary = JSON.parse((result.content[0] as { text: string }).text);
    expect(markerActions).toEqual(['prepare', 'show', 'hide', 'finish']);
    expect(rects[0]).toEqual({ x: 10, y: 20, width: 80, height: 40 });
    expect(summary).toMatchObject({ frames: 5, distinctFrames: 1, fps: 10, viewport: { width: 80, height: 40 }, frameSize: { width: 64, height: 32 } });
    expect(summary.note).toContain('Studio drew slower than fps');
    expect(summary.sheet).toMatchObject({ frames: 4, columns: 4 });
    expect(fs.readdirSync(summary.folder).filter((name) => name.endsWith('.png'))).toHaveLength(5);
    expect(JSON.parse(fs.readFileSync(path.join(summary.folder, 'frames.json'), 'utf8')).frames).toHaveLength(5);
    expect(result.content[1]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' });
    expect(closed).toBe(true);
  });

  test('a failure while locating the viewport still hides the markers and ends the transaction', async () => {
    jest.replaceProperty(process, 'env', { ...process.env, ROBLOX_STUDIO_HOST_CAPTURE: '1' });
    const markerActions: string[] = [];
    const source: FrameSource = {
      grabWindow: async () => {
        throw new Error("the Studio window 'Arena - Roblox Studio' is minimized; restore it (it may stay behind other windows)");
      },
      grabRect: async () => sourceFrame(1, 1, 0),
      close: () => undefined,
    };
    const tools = makeTools(source, markerActions, { value: false });
    await expect(tools.recordViewport('instance:test', {})).rejects.toThrow('is minimized');
    expect(markerActions).toEqual(['prepare', 'show', 'hide', 'finish']);
  });

  test('settings out of range are refused before anything runs', async () => {
    jest.replaceProperty(process, 'env', { ...process.env, ROBLOX_STUDIO_HOST_CAPTURE: '1' });
    const markerActions: string[] = [];
    const tools = makeTools({ grabWindow: async () => windowFrame(false), grabRect: async () => sourceFrame(1, 1, 0), close: () => undefined }, markerActions, { value: false });
    await expect(tools.recordViewport('instance:test', { duration_s: 31 })).rejects.toThrow('duration_s must be a number from 0.5 to 30');
    await expect(tools.recordViewport('instance:test', { fps: 2.5 })).rejects.toThrow('fps must be a whole number from 1 to 30');
    expect(markerActions).toEqual([]);
  });
});
