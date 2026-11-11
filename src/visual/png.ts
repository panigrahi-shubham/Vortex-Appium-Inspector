// Minimal PNG reader/writer (no dependencies: node:zlib only) and a few image helpers.
// Reads 8-bit non-interlaced PNGs of every colour type (what adb screencap, Appium and browsers produce);
// anything else is refused with a clear message instead of being guessed.

import { deflateSync, inflateSync } from 'node:zlib';

export interface Image {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row-major. */
  data: Uint8Array;
}

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export class PngError extends Error {}

/** Reads the pixel coordinate space without decoding/inflating the screenshot. */
export function pngDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(SIG) || buf.readUInt32BE(8) !== 13 || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20);
  return width > 0 && height > 0 && width <= 0x7fffffff && height <= 0x7fffffff ? { width, height } : null;
}

export function decodePng(buf: Buffer): Image {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) throw new PngError('not a PNG file');
  let off = 8;
  let width = 0, height = 0, depth = 0, color = 0, interlace = 0;
  let palette: Buffer | null = null;
  let trns: Buffer | null = null;
  const idat: Buffer[] = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    off += 12 + len;
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      color = body[9];
      interlace = body[12];
    } else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') trns = body;
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
  }
  if (!width || !height) throw new PngError('PNG has no image header');
  if (depth !== 8) throw new PngError(`PNG bit depth ${depth} is not supported (8-bit only)`);
  if (interlace) throw new PngError('interlaced PNGs are not supported');
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color];
  if (!channels) throw new PngError(`PNG colour type ${color} is not supported`);
  if (color === 3 && !palette) throw new PngError('palette PNG without a palette');
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) throw new PngError('PNG data is truncated');
  const px = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const r = raw[src + x];
      const a = x >= channels ? px[dst + x - channels] : 0;
      const b = y > 0 ? px[dst - stride + x] : 0;
      const c = x >= channels && y > 0 ? px[dst - stride + x - channels] : 0;
      let v: number;
      switch (f) {
        case 0: v = r; break;
        case 1: v = r + a; break;
        case 2: v = r + b; break;
        case 3: v = r + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = r + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new PngError(`unknown PNG filter ${f}`);
      }
      px[dst + x] = v & 255;
    }
  }
  const out = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += channels) {
    const o = i * 4;
    if (color === 6) { out[o] = px[j]; out[o + 1] = px[j + 1]; out[o + 2] = px[j + 2]; out[o + 3] = px[j + 3]; }
    else if (color === 2) { out[o] = px[j]; out[o + 1] = px[j + 1]; out[o + 2] = px[j + 2]; out[o + 3] = 255; }
    else if (color === 0) { out[o] = out[o + 1] = out[o + 2] = px[j]; out[o + 3] = 255; }
    else if (color === 4) { out[o] = out[o + 1] = out[o + 2] = px[j]; out[o + 3] = px[j + 1]; }
    else {
      const k = px[j];
      out[o] = palette![k * 3]; out[o + 1] = palette![k * 3 + 1]; out[o + 2] = palette![k * 3 + 2];
      out[o + 3] = trns && k < trns.length ? trns[k] : 255;
    }
  }
  return { width, height, data: out };
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const tb = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(tb));
  return Buffer.concat([len, tb, crc]);
}

export function encodePng(img: Image): Buffer {
  const hdr = Buffer.alloc(13);
  hdr.writeUInt32BE(img.width, 0);
  hdr.writeUInt32BE(img.height, 4);
  hdr[8] = 8;
  hdr[9] = 6;
  const stride = img.width * 4;
  const raw = Buffer.alloc(img.height * (stride + 1));
  for (let y = 0; y < img.height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(img.data.buffer, img.data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([SIG, chunk('IHDR', hdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export function crop(img: Image, x: number, y: number, w: number, h: number): Image {
  const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(img.width, Math.round(x + w)), y1 = Math.min(img.height, Math.round(y + h));
  const W = Math.max(0, x1 - x0), H = Math.max(0, y1 - y0);
  const data = new Uint8Array(W * H * 4);
  for (let r = 0; r < H; r++) data.set(img.data.subarray(((y0 + r) * img.width + x0) * 4, ((y0 + r) * img.width + x1) * 4), r * W * 4);
  return { width: W, height: H, data };
}

/** Copies `src` onto `dst` at (x, y), clipped to `dst`. */
export function blit(dst: Image, src: Image, x: number, y: number): void {
  for (let r = 0; r < src.height; r++) {
    const ty = y + r;
    if (ty < 0 || ty >= dst.height) continue;
    const sx0 = Math.max(0, -x), sx1 = Math.min(src.width, dst.width - x);
    if (sx1 <= sx0) continue;
    dst.data.set(src.data.subarray((r * src.width + sx0) * 4, (r * src.width + sx1) * 4), (ty * dst.width + x + sx0) * 4);
  }
}

/** Luminance (0..255) as floats. */
export function gray(img: Image): Float32Array {
  const g = new Float32Array(img.width * img.height);
  for (let i = 0; i < g.length; i++) g[i] = 0.299 * img.data[i * 4] + 0.587 * img.data[i * 4 + 1] + 0.114 * img.data[i * 4 + 2];
  return g;
}

/** Box-filter resize of a grey image to (w, h). */
export function resizeGray(src: Float32Array, sw: number, sh: number, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  const fx = sw / w, fy = sh / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * fy), y1 = Math.max(y0 + 1, Math.min(sh, Math.floor((y + 1) * fy)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * fx), x1 = Math.max(x0 + 1, Math.min(sw, Math.floor((x + 1) * fx)));
      let s = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) s += src[yy * sw + xx];
      out[y * w + x] = s / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

/** Nearest-neighbour RGBA resize (for scaling templates). */
export function resize(img: Image, w: number, h: number): Image {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.floor((y * img.height) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor((x * img.width) / w));
      data.set(img.data.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4), (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data };
}
