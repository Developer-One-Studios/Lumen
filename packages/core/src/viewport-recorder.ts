// Records the Studio viewport as a run of frames, for judging motion, timing and transitions that one screenshot cannot show.
// On Linux each frame is read straight from the X server (a few ms). Elsewhere it goes through the host window capture
// helper once per frame, which is far slower, so the reachable frame rate there is low.
import type { HostCaptureResult, HostWindowIdentity, ViewportRect } from './host-capture.js';
import { pickStudioWindow } from './host-capture-linux.js';
import { downscaleRgba, type RgbaFrame } from './image-resize.js';
import { X11_BAD_MATCH, X11Connection, X11Error, listTopLevelWindows, toRgbaInPlace, type PixelLayout } from './x11-client.js';

/** A frame in its source's channel order. Downscaling averages channels independently, so the order can be fixed afterwards. */
export interface SourceFrame {
  width: number;
  height: number;
  data: Buffer;
  layout: PixelLayout;
}

export interface FrameSource {
  /** The whole Studio window, as RGBA. */
  grabWindow(): Promise<RgbaFrame>;
  /** A rectangle of the window, in window coordinates. */
  grabRect(rect: ViewportRect): Promise<SourceFrame>;
  close(): void;
}

const RGBA_LAYOUT: PixelLayout = { r: 0, g: 1, b: 2 };

export function minimizedMessage(title: string): string {
  return `the Studio window '${title}' is minimized; restore it (it may stay behind other windows)`;
}

/** Linux: reads the Studio window from the X server. A minimized window has no pixels, so it is refused up front. */
export async function openX11FrameSource(
  titleHint: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  socketPath?: string,
): Promise<FrameSource> {
  const connection = await X11Connection.open(env, socketPath);
  try {
    const picked = pickStudioWindow(await listTopLevelWindows(connection), titleHint);
    if (typeof picked === 'string') throw new Error(picked);
    if ((await connection.mapState(picked.id)) !== 'viewable') throw new Error(minimizedMessage(picked.title));

    const grab = async (x: number, y: number, width: number, height: number) => {
      try {
        return await connection.getImage(picked.id, x, y, width, height);
      } catch (error) {
        // BadMatch is what the X server answers for a window that stopped being viewable, which is a minimize.
        if (error instanceof X11Error && error.code === X11_BAD_MATCH && (await connection.mapState(picked.id)) !== 'viewable') {
          throw new Error(minimizedMessage(picked.title));
        }
        throw error;
      }
    };
    return {
      grabWindow: async () => {
        const { width, height } = await connection.getGeometry(picked.id);
        const image = await grab(0, 0, width, height);
        return { width, height, rgba: toRgbaInPlace(Buffer.from(image.data), image.layout) };
      },
      grabRect: async (rect) => {
        const image = await grab(rect.x, rect.y, rect.width, rect.height);
        return { width: rect.width, height: rect.height, data: image.data, layout: image.layout };
      },
      close: () => connection.close(),
    };
  } catch (error) {
    connection.close();
    throw error;
  }
}

/** Windows and macOS: one host window capture per frame, the crop taken from the whole window. */
export function hostWindowFrameSource(
  capture: (titleHint?: string, expectedIdentity?: HostWindowIdentity) => Promise<HostCaptureResult>,
  titleHint: string | undefined,
): FrameSource {
  let identity: HostWindowIdentity | undefined;
  const grabWindow = async (): Promise<RgbaFrame> => {
    const result = await capture(titleHint, identity);
    if (!result.ok) throw new Error(result.error);
    identity ??= result.capture.identity;
    return { width: result.capture.width, height: result.capture.height, rgba: result.capture.rgba };
  };
  return {
    grabWindow,
    grabRect: async (rect) => {
      const window = await grabWindow();
      if (rect.x + rect.width > window.width || rect.y + rect.height > window.height) {
        throw new Error('the Studio window shrank below the recorded viewport');
      }
      const data = Buffer.alloc(rect.width * rect.height * 4);
      for (let y = 0; y < rect.height; y++) {
        const from = ((rect.y + y) * window.width + rect.x) * 4;
        window.rgba.copy(data, y * rect.width * 4, from, from + rect.width * 4);
      }
      return { width: rect.width, height: rect.height, data, layout: RGBA_LAYOUT };
    },
    close: () => undefined,
  };
}

export interface RecordedFrame {
  offsetMs: number;
  unixMs: number;
  frame: RgbaFrame;
  /** The same pixels as the frame before, which means Studio drew no new frame in between. */
  repeat: boolean;
}

export interface RecordOptions {
  source: FrameSource;
  rect: ViewportRect;
  fps: number;
  durationMs: number;
  width: number;
  height: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

export interface Recording {
  frames: RecordedFrame[];
  /** Ticks that came due while the previous frame was still being read, so the frame rate fell behind. */
  lateTicks: number;
  stoppedEarly?: string;
}

/** Shrinks a frame and puts its channels in RGBA order. */
export function shrinkFrame(source: SourceFrame, width: number, height: number): RgbaFrame {
  const shrunk = downscaleRgba({ width: source.width, height: source.height, rgba: source.data }, width, height);
  const rgba = shrunk.rgba === source.data ? Buffer.from(source.data) : shrunk.rgba;
  return { width, height, rgba: toRgbaInPlace(rgba, source.layout) };
}

export async function recordFrames(options: RecordOptions): Promise<Recording> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const interval = 1000 / options.fps;
  const total = Math.max(1, Math.floor(options.durationMs / interval));
  const frames: RecordedFrame[] = [];
  let lateTicks = 0;
  let stoppedEarly: string | undefined;
  const start = now();
  for (let tick = 0; tick < total; tick++) {
    if (options.signal?.aborted) {
      stoppedEarly = 'cancelled';
      break;
    }
    const wait = start + tick * interval - now();
    if (wait > 0) await sleep(wait);
    else if (tick > 0) lateTicks++;
    const taken = now();
    let frame: RgbaFrame;
    try {
      frame = shrinkFrame(await options.source.grabRect(options.rect), options.width, options.height);
    } catch (error) {
      if (frames.length === 0) throw error;
      stoppedEarly = error instanceof Error ? error.message : String(error);
      break;
    }
    const previous = frames[frames.length - 1];
    frames.push({ offsetMs: taken - start, unixMs: taken, frame, repeat: previous !== undefined && previous.frame.rgba.equals(frame.rgba) });
  }
  return { frames, lateTicks, ...(stoppedEarly ? { stoppedEarly } : {}) };
}

/** Evenly spaced picks of count items out of total, first and last included. */
export function spreadIndices(total: number, count: number): number[] {
  if (total <= count) return Array.from({ length: total }, (_, i) => i);
  if (count === 1) return [0];
  return Array.from({ length: count }, (_, i) => Math.round((i * (total - 1)) / (count - 1)));
}

// 3x5 glyphs for the time labels, one string per row, '#' lit.
const GLYPHS: Record<string, string[]> = {
  '0': ['###', '#.#', '#.#', '#.#', '###'],
  '1': ['.#.', '##.', '.#.', '.#.', '###'],
  '2': ['###', '..#', '###', '#..', '###'],
  '3': ['###', '..#', '###', '..#', '###'],
  '4': ['#.#', '#.#', '###', '..#', '..#'],
  '5': ['###', '#..', '###', '..#', '###'],
  '6': ['###', '#..', '###', '#.#', '###'],
  '7': ['###', '..#', '..#', '..#', '..#'],
  '8': ['###', '#.#', '###', '#.#', '###'],
  '9': ['###', '#.#', '###', '..#', '###'],
  '.': ['...', '...', '...', '...', '.#.'],
  s: ['...', '###', '#..', '.##', '##.'],
};

/** Draws text on a dark box at x, y, every glyph pixel a scale by scale square. Unknown characters are skipped. */
export function drawLabel(target: RgbaFrame, x: number, y: number, label: string, scale: number): void {
  const glyphs = [...label].map((char) => GLYPHS[char]).filter((glyph): glyph is string[] => glyph !== undefined);
  const boxWidth = (glyphs.length * 4 + 1) * scale;
  const boxHeight = 7 * scale;
  const paint = (px: number, py: number, value: number) => {
    if (px < 0 || py < 0 || px >= target.width || py >= target.height) return;
    const offset = (py * target.width + px) * 4;
    target.rgba[offset] = value;
    target.rgba[offset + 1] = value;
    target.rgba[offset + 2] = value;
    target.rgba[offset + 3] = 255;
  };
  for (let py = 0; py < boxHeight; py++) for (let px = 0; px < boxWidth; px++) paint(x + px, y + py, 0);
  glyphs.forEach((glyph, index) => {
    for (let row = 0; row < 5; row++) {
      for (let column = 0; column < 3; column++) {
        if (glyph[row][column] !== '#') continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) paint(x + (1 + index * 4 + column) * scale + dx, y + (1 + row) * scale + dy, 255);
        }
      }
    }
  });
}

export function timeLabel(offsetMs: number): string {
  return `${(offsetMs / 1000).toFixed(2)}s`;
}

/** Tiles frames in reading order, each with its time in the top-left corner. */
export function buildContactSheet(tiles: Array<{ frame: RgbaFrame; label: string }>, columns: number, tileWidth: number): RgbaFrame {
  const gap = 4;
  const first = tiles[0].frame;
  const tileHeight = Math.max(1, Math.round((first.height * tileWidth) / first.width));
  const rows = Math.ceil(tiles.length / columns);
  const width = columns * tileWidth + (columns + 1) * gap;
  const height = rows * tileHeight + (rows + 1) * gap;
  const sheet: RgbaFrame = { width, height, rgba: Buffer.alloc(width * height * 4) };
  for (let i = 3; i < sheet.rgba.length; i += 4) sheet.rgba[i] = 255;
  const scale = tileWidth >= 240 ? 2 : 1;
  tiles.forEach((tile, index) => {
    const shrunk = tile.frame.width > tileWidth ? downscaleRgba(tile.frame, tileWidth, tileHeight) : tile.frame;
    const left = gap + (index % columns) * (tileWidth + gap);
    const top = gap + Math.floor(index / columns) * (tileHeight + gap);
    for (let y = 0; y < Math.min(tileHeight, shrunk.height); y++) {
      shrunk.rgba.copy(sheet.rgba, ((top + y) * width + left) * 4, y * shrunk.width * 4, (y * shrunk.width + Math.min(tileWidth, shrunk.width)) * 4);
    }
    drawLabel(sheet, left, top, tile.label, scale);
  });
  return sheet;
}
