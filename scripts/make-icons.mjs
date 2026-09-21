#!/usr/bin/env node
/**
 * Builds the desktop app icons from assets/pixel-agent-logo.png (adapted from Token Terrier).
 *
 *   npm run icon
 *
 * Outputs (in assets/desktop-icons/, committed):
 *   icon.png                 1024x1024 full-bleed  -> build.linux.icon and build.win.icon
 *                            (Hutch derives the Windows .ico from the PNG)
 *   icon-mac.png             1024x1024, art inset to ~80% with a transparent margin (macOS convention)
 *   icon.iconset/*.png       the ten standard sizes cut from icon-mac.png -> build.mac.icons
 *                            (`iconutil` turns the folder into .icns, on a macOS build host)
 *
 * Deterministic: the same input gives byte-identical output. The logo is padded to a square first
 * (it is 1037x1034) and resampled with an alpha-aware (premultiplied) area filter. Only 8-bit RGBA,
 * non-interlaced sources are accepted; anything else is rejected instead of being mis-decoded.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCE = path.join(root, 'assets', 'pixel-agent-logo.png');
export const OUT_DIR = path.join(root, 'assets', 'desktop-icons');
export const MASTER_SIZE = 1024;
/** macOS icons keep a margin: the art occupies about 80% of the canvas. */
export const MAC_ART_SIZE = 824;
export const ICONSET_SIZES = [16, 32, 128, 256, 512];

/** Reads the IHDR directly so an unsupported PNG variant fails loudly. */
export function assertSupportedPng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('Not a PNG file');
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') throw new Error('PNG is missing its IHDR chunk');
  const bitDepth = buffer[24];
  const colorType = buffer[25];
  const interlace = buffer[28];
  if (bitDepth !== 8 || colorType !== 6 || interlace !== 0)
    throw new Error(
      `Logo must be 8-bit RGBA and non-interlaced (got depth ${bitDepth}, colour type ${colorType}, interlace ${interlace}); convert it first`,
    );
}

/** @returns {{ w: number, h: number, px: Uint8Array }} */
export function decode(buffer) {
  assertSupportedPng(buffer);
  const png = PNG.sync.read(buffer);
  return { w: png.width, h: png.height, px: new Uint8Array(png.data) };
}

export function encode(image) {
  const png = new PNG({ width: image.w, height: image.h });
  png.data = Buffer.from(image.px);
  return PNG.sync.write(png, { deflateLevel: 9, filterType: 4 });
}

/** Centres the image on a transparent square canvas of side max(w, h). */
export function padToSquare(image) {
  const side = Math.max(image.w, image.h);
  if (image.w === image.h) return image;
  const px = new Uint8Array(side * side * 4);
  const ox = Math.floor((side - image.w) / 2);
  const oy = Math.floor((side - image.h) / 2);
  for (let y = 0; y < image.h; y++)
    px.set(image.px.subarray(y * image.w * 4, (y + 1) * image.w * 4), ((y + oy) * side + ox) * 4);
  return { w: side, h: side, px };
}

/** Area-average resample in premultiplied alpha, so transparent edges never bleed dark fringes. */
export function resize(image, size) {
  const out = new Uint8Array(size * size * 4);
  const scaleX = image.w / size;
  const scaleY = image.h / size;
  for (let y = 0; y < size; y++) {
    const y0 = y * scaleY;
    const y1 = y0 + scaleY;
    for (let x = 0; x < size; x++) {
      const x0 = x * scaleX;
      const x1 = x0 + scaleX;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let weight = 0;
      for (let sy = Math.floor(y0); sy < Math.min(image.h, Math.ceil(y1)); sy++) {
        const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
        for (let sx = Math.floor(x0); sx < Math.min(image.w, Math.ceil(x1)); sx++) {
          const w = wy * (Math.min(sx + 1, x1) - Math.max(sx, x0));
          const i = (sy * image.w + sx) * 4;
          const alpha = image.px[i + 3] / 255;
          r += image.px[i] * alpha * w;
          g += image.px[i + 1] * alpha * w;
          b += image.px[i + 2] * alpha * w;
          a += alpha * w;
          weight += w;
        }
      }
      const o = (y * size + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round((a / weight) * 255);
    }
  }
  return { w: size, h: size, px: out };
}

/** Places `art` (square) centred on a transparent square canvas. */
export function centreOnCanvas(art, canvas) {
  const px = new Uint8Array(canvas * canvas * 4);
  const offset = Math.floor((canvas - art.w) / 2);
  for (let y = 0; y < art.h; y++)
    px.set(
      art.px.subarray(y * art.w * 4, (y + 1) * art.w * 4),
      ((y + offset) * canvas + offset) * 4,
    );
  return { w: canvas, h: canvas, px };
}

/** Every output as `relative path -> PNG bytes`. Pure: touches no files. */
export function buildIcons(sourceBuffer) {
  const square = padToSquare(decode(sourceBuffer));
  const master = resize(square, MASTER_SIZE);
  const mac = centreOnCanvas(resize(square, MAC_ART_SIZE), MASTER_SIZE);
  const files = new Map([
    ['icon.png', encode(master)],
    ['icon-mac.png', encode(mac)],
  ]);
  for (const size of ICONSET_SIZES) {
    files.set(`icon.iconset/icon_${size}x${size}.png`, encode(resize(mac, size)));
    files.set(`icon.iconset/icon_${size}x${size}@2x.png`, encode(resize(mac, size * 2)));
  }
  return files;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = buildIcons(fs.readFileSync(SOURCE));
  for (const [relative, bytes] of files) {
    const target = path.join(OUT_DIR, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    console.log(`wrote ${path.relative(root, target)} (${bytes.length} bytes)`);
  }
}
