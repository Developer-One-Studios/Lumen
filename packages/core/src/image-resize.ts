export interface RgbaFrame {
  width: number;
  height: number;
  rgba: Buffer;
}

/** The size a frame shrinks to so it is at most maxWidth wide, aspect ratio kept. Narrower frames keep their size. */
export function fitWidth(width: number, height: number, maxWidth: number): { width: number; height: number } {
  if (width <= maxWidth) return { width, height };
  return { width: maxWidth, height: Math.max(1, Math.round((height * maxWidth) / width)) };
}

type Span = { start: number; weights: Float64Array };

// Output pixel i covers source range [i * scale, (i + 1) * scale), and partly covered source pixels count by the fraction covered.
function spans(source: number, target: number): Span[] {
  const scale = source / target;
  const result: Span[] = [];
  for (let i = 0; i < target; i++) {
    const from = i * scale;
    const to = Math.min(source, (i + 1) * scale);
    const start = Math.floor(from);
    const weights = new Float64Array(Math.ceil(to) - start);
    for (let s = start; s < start + weights.length; s++) {
      weights[s - start] = (Math.min(s + 1, to) - Math.max(s, from)) / scale;
    }
    result.push({ start, weights });
  }
  return result;
}

/**
 * Downscales with an area-average box filter, so every output pixel is the mean of the source area it covers.
 * Thin lines and small text then fade instead of vanishing the way nearest sampling drops them.
 */
export function downscaleRgba(frame: RgbaFrame, width: number, height: number): RgbaFrame {
  if (frame.rgba.length !== frame.width * frame.height * 4) {
    throw new Error(`RGBA buffer holds ${frame.rgba.length} bytes, expected ${frame.width * frame.height * 4} for ${frame.width}x${frame.height}`);
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > frame.width || height > frame.height) {
    throw new Error(`cannot downscale ${frame.width}x${frame.height} to ${width}x${height}`);
  }
  if (width === frame.width && height === frame.height) return frame;

  const columns = spans(frame.width, width);
  const rows = spans(frame.height, height);
  const source = frame.rgba;
  const out = Buffer.alloc(width * height * 4);
  const sum = new Float64Array(width * 4);
  // Viewport frames are opaque, so channels average independently without premultiplying alpha.
  for (let y = 0; y < height; y++) {
    sum.fill(0);
    const row = rows[y];
    for (let j = 0; j < row.weights.length; j++) {
      const rowWeight = row.weights[j];
      if (rowWeight === 0) continue;
      const rowOffset = (row.start + j) * frame.width * 4;
      for (let x = 0; x < width; x++) {
        const column = columns[x];
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let i = 0; i < column.weights.length; i++) {
          const weight = column.weights[i];
          const offset = rowOffset + (column.start + i) * 4;
          r += source[offset] * weight;
          g += source[offset + 1] * weight;
          b += source[offset + 2] * weight;
          a += source[offset + 3] * weight;
        }
        const target = x * 4;
        sum[target] += r * rowWeight;
        sum[target + 1] += g * rowWeight;
        sum[target + 2] += b * rowWeight;
        sum[target + 3] += a * rowWeight;
      }
    }
    const outOffset = y * width * 4;
    for (let k = 0; k < sum.length; k++) out[outOffset + k] = Math.min(255, Math.round(sum[k]));
  }
  return { width, height, rgba: out };
}
