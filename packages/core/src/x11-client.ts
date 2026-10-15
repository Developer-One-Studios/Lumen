// A minimal X11 client over the display's Unix socket, enough to find a window and read its pixels.
// Studio on Linux is a Wine window drawn through XWayland, and asking the X server for its pixels directly
// takes a few milliseconds per frame, against a process spawn per frame for the stock X11 tools.
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';

const ERROR_NAMES: Record<number, string> = {
  1: 'BadRequest', 2: 'BadValue', 3: 'BadWindow', 4: 'BadPixmap', 5: 'BadAtom', 8: 'BadMatch', 9: 'BadDrawable', 11: 'BadAlloc', 16: 'BadLength',
};
export const X11_BAD_MATCH = 8;

export class X11Error extends Error {
  constructor(readonly code: number, readonly majorOpcode: number) {
    super(`X11 ${ERROR_NAMES[code] ?? `error ${code}`} on request ${majorOpcode}`);
  }
}

// Atoms every X server predefines.
export const ATOM_STRING = 31;
export const ATOM_WM_NAME = 39;
export const ATOM_WM_CLASS = 67;

const OPCODE = { getWindowAttributes: 3, queryTree: 15, internAtom: 16, getProperty: 20, getGeometry: 14, getImage: 73 } as const;
const REQUEST_TIMEOUT_MS = 10_000;

export interface X11Visual {
  id: number;
  depth: number;
  redMask: number;
  greenMask: number;
  blueMask: number;
}

export interface X11Setup {
  root: number;
  lsbFirst: boolean;
  bitsPerPixel: Map<number, number>;
  visuals: Map<number, X11Visual>;
}

/** The Unix socket of a local display such as ":0" or ":1.0". Displays on another host are not supported. */
export function displaySocket(display: string | undefined): { path: string; number: string } | undefined {
  const match = /^(?:unix)?:(\d+)(?:\.\d+)?$/.exec(display?.trim() ?? '');
  return match ? { path: `/tmp/.X11-unix/X${match[1]}`, number: match[1] } : undefined;
}

/** The MIT-MAGIC-COOKIE-1 for a display in an Xauthority file, whose fields are length-prefixed big endian. */
export function findXauthCookie(data: Buffer, displayNumber: string): Buffer | undefined {
  let offset = 0;
  const field = (): Buffer => {
    if (offset + 2 > data.length) throw new RangeError('truncated Xauthority entry');
    const length = data.readUInt16BE(offset);
    if (offset + 2 + length > data.length) throw new RangeError('truncated Xauthority entry');
    const value = data.subarray(offset + 2, offset + 2 + length);
    offset += 2 + length;
    return value;
  };
  try {
    while (offset < data.length) {
      offset += 2; // address family
      field(); // address
      const number = field().toString('latin1');
      const name = field().toString('latin1');
      const cookie = field();
      if (name === 'MIT-MAGIC-COOKIE-1' && (number === displayNumber || number === '')) return cookie;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

const pad4 = (n: number) => (4 - (n % 4)) % 4;

/** Reads the parts of the connection setup this client needs: the first screen's root, pixel formats and visuals. */
export function parseSetup(data: Buffer): X11Setup {
  const vendorLength = data.readUInt16LE(16);
  const screenCount = data[20];
  const formatCount = data[21];
  if (screenCount < 1) throw new Error('the X server reported no screens');
  const bitsPerPixel = new Map<number, number>();
  let offset = 32 + vendorLength + pad4(vendorLength);
  for (let i = 0; i < formatCount; i++, offset += 8) bitsPerPixel.set(data[offset], data[offset + 1]);

  const root = data.readUInt32LE(offset);
  const depthCount = data[offset + 39];
  offset += 40;
  const visuals = new Map<number, X11Visual>();
  for (let d = 0; d < depthCount; d++) {
    const depth = data[offset];
    const visualCount = data.readUInt16LE(offset + 2);
    offset += 8;
    for (let v = 0; v < visualCount; v++, offset += 24) {
      visuals.set(data.readUInt32LE(offset), {
        id: data.readUInt32LE(offset),
        depth,
        redMask: data.readUInt32LE(offset + 8),
        greenMask: data.readUInt32LE(offset + 12),
        blueMask: data.readUInt32LE(offset + 16),
      });
    }
  }
  return { root, lsbFirst: data[22] === 0, bitsPerPixel, visuals };
}

/** The byte that holds a channel in a 32 bit pixel, for the 8 bit channel layouts every TrueColor visual in practice uses. */
function channelByte(mask: number, lsbFirst: boolean): number {
  for (let shift = 0; shift <= 24; shift += 8) {
    if (mask >>> 0 === (0xff << shift) >>> 0) return lsbFirst ? shift / 8 : 3 - shift / 8;
  }
  throw new Error(`unsupported X11 visual channel mask 0x${mask.toString(16)}`);
}

export interface PixelLayout {
  /** Byte offsets of red, green and blue inside each 4 byte pixel. */
  r: number;
  g: number;
  b: number;
}

export function pixelLayout(visual: X11Visual, lsbFirst: boolean): PixelLayout {
  return { r: channelByte(visual.redMask, lsbFirst), g: channelByte(visual.greenMask, lsbFirst), b: channelByte(visual.blueMask, lsbFirst) };
}

/** Rewrites 4 byte pixels in place into RGBA with full alpha. */
export function toRgbaInPlace(data: Buffer, layout: PixelLayout): Buffer {
  const { r, g, b } = layout;
  for (let i = 0; i < data.length; i += 4) {
    const red = data[i + r];
    const green = data[i + g];
    const blue = data[i + b];
    data[i] = red;
    data[i + 1] = green;
    data[i + 2] = blue;
    data[i + 3] = 255;
  }
  return data;
}

export type MapState = 'unmapped' | 'unviewable' | 'viewable';

export interface X11Image {
  width: number;
  height: number;
  /** 4 bytes per pixel in the window visual's own channel order, see layout. */
  data: Buffer;
  layout: PixelLayout;
}

export class X11Connection {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private wake?: () => void;
  private failure?: Error;
  private sequence = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private parsedSetup?: X11Setup;

  get setup(): X11Setup {
    if (!this.parsedSetup) throw new Error('the X11 connection is not set up');
    return this.parsedSetup;
  }

  private constructor(private readonly socket: net.Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.chunks.push(chunk);
      this.buffered += chunk.length;
      this.wake?.();
    });
    const fail = (error: Error) => {
      this.failure ??= error;
      this.wake?.();
    };
    socket.on('error', fail);
    socket.on('close', () => fail(new Error('the X server closed the connection')));
  }

  /** Connects to $DISPLAY with the cookie from $XAUTHORITY or ~/.Xauthority. socketPath replaces the display's socket in tests. */
  static async open(env: NodeJS.ProcessEnv = process.env, socketPath?: string): Promise<X11Connection> {
    const display = displaySocket(env.DISPLAY);
    if (!display) throw new Error(`DISPLAY "${env.DISPLAY ?? ''}" is not a local X11 display`);
    let cookie: Buffer | undefined;
    try {
      cookie = findXauthCookie(fs.readFileSync(env.XAUTHORITY || `${os.homedir()}/.Xauthority`), display.number);
    } catch {
      cookie = undefined;
    }

    const path = socketPath ?? display.path;
    const socket = net.connect(path);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', (error) => reject(new Error(`could not connect to the X server at ${path}: ${error.message}`)));
    });
    const connection = new X11Connection(socket);

    const name = cookie ? Buffer.from('MIT-MAGIC-COOKIE-1') : Buffer.alloc(0);
    const auth = cookie ?? Buffer.alloc(0);
    const request = Buffer.alloc(12 + name.length + pad4(name.length) + auth.length + pad4(auth.length));
    request.write('l', 0, 'latin1');
    request.writeUInt16LE(11, 2);
    request.writeUInt16LE(name.length, 6);
    request.writeUInt16LE(auth.length, 8);
    name.copy(request, 12);
    auth.copy(request, 12 + name.length + pad4(name.length));
    socket.write(request);

    try {
      const head = await connection.read(8);
      const body = await connection.read(head.readUInt16LE(6) * 4);
      if (head[0] !== 1) {
        const reason = head[0] === 0 ? body.subarray(0, head[1]).toString('latin1') : 'more authentication required';
        throw new Error(`the X server refused the connection: ${reason.trim() || 'no reason given'}`);
      }
      connection.parsedSetup = parseSetup(body);
      return connection;
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }

  close(): void {
    this.socket.destroy();
  }

  private async read(length: number): Promise<Buffer> {
    if (length === 0) return Buffer.alloc(0);
    const deadline = Date.now() + REQUEST_TIMEOUT_MS;
    while (this.buffered < length) {
      if (this.failure) throw this.failure;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('the X server did not answer in time');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = undefined;
    }
    if (this.chunks.length > 1) this.chunks = [Buffer.concat(this.chunks)];
    const all = this.chunks[0];
    const out = all.subarray(0, length);
    const rest = all.subarray(length);
    this.chunks = rest.length > 0 ? [rest] : [];
    this.buffered -= length;
    return out;
  }

  /** Sends one request and returns its whole reply. Requests run one at a time, so replies cannot interleave. */
  private request(packet: Buffer): Promise<Buffer> {
    const run = async (): Promise<Buffer> => {
      this.sequence = (this.sequence + 1) & 0xffff;
      const sequence = this.sequence;
      this.socket.write(packet);
      for (;;) {
        const head = await this.read(32);
        const kind = head[0] & 0x7f;
        if (kind === 0) {
          if (head.readUInt16LE(2) !== sequence) continue;
          throw new X11Error(head[1], head[10]);
        }
        if (kind === 1) {
          const body = await this.read(head.readUInt32LE(4) * 4);
          if (head.readUInt16LE(2) !== sequence) continue;
          return Buffer.concat([head, body]);
        }
        // An event nobody asked for. GenericEvent (35) carries a body like a reply.
        if (kind === 35) await this.read(head.readUInt32LE(4) * 4);
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private static packet(opcode: number, data: number, words: number[], tail?: Buffer): Buffer {
    const length = 4 + words.length * 4 + (tail ? tail.length + pad4(tail.length) : 0);
    const packet = Buffer.alloc(length);
    packet[0] = opcode;
    packet[1] = data;
    packet.writeUInt16LE(length / 4, 2);
    words.forEach((word, i) => packet.writeUInt32LE(word >>> 0, 4 + i * 4));
    tail?.copy(packet, 4 + words.length * 4);
    return packet;
  }

  async internAtom(name: string, onlyIfExists = false): Promise<number> {
    const bytes = Buffer.from(name, 'latin1');
    const tail = Buffer.alloc(4 + bytes.length);
    tail.writeUInt16LE(bytes.length, 0);
    bytes.copy(tail, 4);
    return (await this.request(X11Connection.packet(OPCODE.internAtom, onlyIfExists ? 1 : 0, [], tail))).readUInt32LE(8);
  }

  /** A property's raw bytes, or undefined when the window does not have it. */
  async getProperty(window: number, property: number, maxBytes = 4096): Promise<{ type: number; format: number; data: Buffer } | undefined> {
    const reply = await this.request(X11Connection.packet(OPCODE.getProperty, 0, [window, property, 0, 0, Math.ceil(maxBytes / 4)]));
    const type = reply.readUInt32LE(8);
    if (type === 0) return undefined;
    const format = reply[1];
    const count = reply.readUInt32LE(16);
    return { type, format, data: reply.subarray(32, 32 + count * (format / 8)) };
  }

  async queryTree(window: number): Promise<number[]> {
    const reply = await this.request(X11Connection.packet(OPCODE.queryTree, 0, [window]));
    const count = reply.readUInt16LE(16);
    return Array.from({ length: count }, (_, i) => reply.readUInt32LE(32 + i * 4));
  }

  async getGeometry(window: number): Promise<{ width: number; height: number }> {
    const reply = await this.request(X11Connection.packet(OPCODE.getGeometry, 0, [window]));
    return { width: reply.readUInt16LE(16), height: reply.readUInt16LE(18) };
  }

  /** A minimized window is unmapped, and the X server keeps no pixels for it. */
  async mapState(window: number): Promise<MapState> {
    const reply = await this.request(X11Connection.packet(OPCODE.getWindowAttributes, 0, [window]));
    return (['unmapped', 'unviewable', 'viewable'] as const)[reply[26]] ?? 'unviewable';
  }

  /** The window's pixels in a rectangle of its own coordinates, read as a ZPixmap. */
  async getImage(window: number, x: number, y: number, width: number, height: number): Promise<X11Image> {
    const packet = X11Connection.packet(OPCODE.getImage, 2, [window, 0, 0, 0xffffffff]);
    packet.writeInt16LE(x, 8);
    packet.writeInt16LE(y, 10);
    packet.writeUInt16LE(width, 12);
    packet.writeUInt16LE(height, 14);
    const reply = await this.request(packet);
    const depth = reply[1];
    const visual = this.setup.visuals.get(reply.readUInt32LE(8));
    const bits = this.setup.bitsPerPixel.get(depth);
    if (!visual || bits !== 32) throw new Error(`unsupported X11 pixel format (depth ${depth}, ${bits ?? '?'} bits per pixel)`);
    const data = reply.subarray(32);
    if (data.length < width * height * 4) throw new Error('the X server returned a short image');
    return { width, height, data: data.subarray(0, width * height * 4), layout: pixelLayout(visual, this.setup.lsbFirst) };
  }
}

export interface X11TopLevel {
  id: number;
  title: string;
  className: string;
  width: number;
  height: number;
}

/** The root's direct children with their titles, classes and sizes. Wine puts each Studio window there. */
export async function listTopLevelWindows(connection: X11Connection): Promise<X11TopLevel[]> {
  const netWmName = await connection.internAtom('_NET_WM_NAME', true);
  const windows: X11TopLevel[] = [];
  for (const id of await connection.queryTree(connection.setup.root)) {
    try {
      const utf8Title = netWmName ? await connection.getProperty(id, netWmName) : undefined;
      const title = utf8Title ? utf8Title.data.toString('utf8') : (await connection.getProperty(id, ATOM_WM_NAME))?.data.toString('latin1') ?? '';
      const wmClass = (await connection.getProperty(id, ATOM_WM_CLASS))?.data.toString('latin1') ?? '';
      const { width, height } = await connection.getGeometry(id);
      windows.push({ id, title, className: wmClass.split('\0').filter(Boolean).join(' '), width, height });
    } catch (error) {
      // A window can vanish between listing and inspecting it.
      if (!(error instanceof X11Error)) throw error;
    }
  }
  return windows;
}
