// Native Linux backend for captureStudioWindow. Studio runs under Wine, which
// draws through the X11 driver, so on Wayland desktops it is an XWayland
// window that the stock X11 tools can find and read without any portal.
import { execFile } from 'child_process';
import { basename } from 'path';
import type { HostCaptureResult, HostWindowIdentity } from './host-capture.js';

const X11_TOOL_TIMEOUT_MS = 15_000;
// A 4K RGBX frame is about 33 MB.
const XWD_MAX_BYTES = 256 * 1024 * 1024;
const WINE_STUDIO_CLASS = 'robloxstudiobeta.exe';
const MIN_STUDIO_WINDOW_EDGE = 200;

export type X11Window = {
  id: number;
  title: string;
  className: string;
  width: number;
  height: number;
};

export type DecodedXwd = { width: number; height: number; rgba: Buffer };

type ToolRunner = (file: string, args: string[]) => Promise<Buffer>;

const runTool: ToolRunner = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { encoding: 'buffer', maxBuffer: XWD_MAX_BYTES, timeout: X11_TOOL_TIMEOUT_MS }, (error, stdout, stderr) => {
    if (error) {
      const detail = Buffer.isBuffer(stderr) ? stderr.toString('utf8').trim() : '';
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      reject(new Error(missing
        ? `${file} is not installed; Linux host capture needs xwininfo, xprop and xwd on PATH`
        : `${file} failed: ${detail || error.message}`));
      return;
    }
    resolve(stdout);
  });
});

export function isLinuxHostCaptureAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.DISPLAY);
}

// One line per window: `0x1a00007 "Title": ("instance" "class")  2560x1369+0+0  +0+0`.
const TREE_LINE = /^\s*(0x[0-9a-f]+) (?:"((?:[^"\\]|\\.)*)"|\(has no name\)): \(([^)]*)\)\s+(\d+)x(\d+)[+-]/i;

export function parseXwininfoTree(output: string): X11Window[] {
  const windows: X11Window[] = [];
  for (const line of output.split('\n')) {
    const match = TREE_LINE.exec(line);
    if (!match) continue;
    windows.push({
      id: Number.parseInt(match[1], 16),
      title: (match[2] ?? '').replace(/\\(.)/g, '$1'),
      className: match[3].replace(/"/g, '').trim(),
      width: Number(match[4]),
      height: Number(match[5]),
    });
  }
  return windows;
}

function isStudioWindow(window: X11Window): boolean {
  const studioTitle = window.title === 'Roblox Studio' || window.title.endsWith(' - Roblox Studio');
  return studioTitle
    && window.className.toLowerCase().includes(WINE_STUDIO_CLASS)
    && window.width >= MIN_STUDIO_WINDOW_EDGE
    && window.height >= MIN_STUDIO_WINDOW_EDGE;
}

// Same rule as the Windows backend: a local file's title carries its full path, so match by basename too.
function matchesTitleHint(title: string, hint: string): boolean {
  const place = title.replace(/ - Roblox Studio$/, '');
  return place.includes(hint) || basename(place) === basename(hint);
}

export function pickStudioWindow(windows: X11Window[], titleHint?: string): X11Window | string {
  const studio = windows.filter(isStudioWindow);
  if (studio.length === 0) return 'no Roblox Studio X11 window was found';
  const matching = titleHint ? studio.filter((window) => matchesTitleHint(window.title, titleHint)) : studio;
  if (matching.length === 0) return `no Roblox Studio X11 window matches "${titleHint}"`;
  // Wine nests the client area inside the toplevel, both carry the title, so keep the outermost per title.
  const byTitle = new Map<string, X11Window>();
  for (const window of matching) {
    const seen = byTitle.get(window.title);
    if (!seen || window.width * window.height > seen.width * seen.height) byTitle.set(window.title, window);
  }
  if (byTitle.size > 1) return `${byTitle.size} Roblox Studio windows match; pass the place's instance_id to pick one`;
  return [...byTitle.values()][0];
}

function maskShift(mask: number): number {
  let shift = 0;
  while (shift < 32 && ((mask >>> shift) & 1) === 0) shift++;
  return shift;
}

function maskWidth(mask: number, shift: number): number {
  let width = 0;
  while (width + shift < 32 && ((mask >>> (shift + width)) & 1) === 1) width++;
  return width;
}

export function decodeXwd(data: Buffer): DecodedXwd {
  if (data.length < 100) throw new Error('xwd output is shorter than its header');
  // xwd always writes the header big endian, the pixels follow byte_order.
  const field = (index: number) => data.readUInt32BE(index * 4);
  const headerSize = field(0);
  if (field(1) !== 7) throw new Error(`unsupported XWD version ${field(1)}`);
  if (field(2) !== 2) throw new Error('XWD image is not ZPixmap');
  const width = field(4);
  const height = field(5);
  const lsbFirst = field(7) === 0;
  const bitsPerPixel = field(11);
  const bytesPerLine = field(12);
  const masks = [field(14), field(15), field(16)];
  const colorCount = field(19);
  if (bitsPerPixel !== 32 && bitsPerPixel !== 24) throw new Error(`unsupported XWD depth of ${bitsPerPixel} bits per pixel`);

  const pixelStart = headerSize + colorCount * 12;
  if (data.length < pixelStart + bytesPerLine * height) throw new Error('xwd output is truncated');

  const bytesPerPixel = bitsPerPixel / 8;
  const channels = masks.map((mask) => {
    const shift = maskShift(mask);
    return { mask, shift, max: 2 ** maskWidth(mask, shift) - 1 };
  });
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = pixelStart + y * bytesPerLine;
    for (let x = 0; x < width; x++) {
      const offset = row + x * bytesPerPixel;
      let pixel = 0;
      for (let byte = 0; byte < bytesPerPixel; byte++) {
        const value = data[offset + byte];
        pixel |= lsbFirst ? value << (8 * byte) : value << (8 * (bytesPerPixel - 1 - byte));
      }
      pixel >>>= 0;
      const out = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const { mask, shift, max } = channels[c];
        rgba[out + c] = max === 0 ? 0 : Math.round((((pixel & mask) >>> shift) * 255) / max);
      }
      rgba[out + 3] = 255;
    }
  }
  return { width, height, rgba };
}

async function windowProcessId(id: number, run: ToolRunner): Promise<number> {
  const output = (await run('xprop', ['-id', `0x${id.toString(16)}`, '_NET_WM_PID'])).toString('utf8');
  const match = /=\s*(\d+)/.exec(output);
  return match ? Number(match[1]) : 0;
}

export async function captureLinuxStudioWindow(
  titleHint?: string,
  expectedIdentity?: HostWindowIdentity,
  run: ToolRunner = runTool,
): Promise<HostCaptureResult> {
  try {
    const tree = (await run('xwininfo', ['-root', '-tree'])).toString('utf8');
    let window: X11Window | string;
    if (expectedIdentity) {
      const known = parseXwininfoTree(tree).find((candidate) => candidate.id === expectedIdentity.windowId);
      window = known && isStudioWindow(known) ? known : 'the previously captured Studio window is gone';
    } else {
      window = pickStudioWindow(parseXwininfoTree(tree), titleHint);
    }
    if (typeof window === 'string') return { ok: false, error: window };

    const identity: HostWindowIdentity = {
      windowId: window.id,
      processId: await windowProcessId(window.id, run),
      bundleIdentifier: WINE_STUDIO_CLASS,
    };
    if (expectedIdentity && expectedIdentity.processId !== identity.processId) {
      return { ok: false, error: 'the Studio window now belongs to a different process' };
    }

    const decoded = decodeXwd(await run('xwd', ['-id', `0x${window.id.toString(16)}`, '-silent']));
    return { ok: true, capture: { ...decoded, title: window.title, identity } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
