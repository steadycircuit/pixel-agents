import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const iconDir = path.join(repo, 'assets', 'desktop-icons');
const icons = (await import(pathToFileURL(path.join(repo, 'scripts', 'make-icons.mjs')).href)) as {
  buildIcons(source: Buffer): Map<string, Buffer>;
  assertSupportedPng(buffer: Buffer): void;
  resize(image: Image, size: number): Image;
  SOURCE: string;
  MASTER_SIZE: number;
  MAC_ART_SIZE: number;
  ICONSET_SIZES: number[];
};

interface Image {
  w: number;
  h: number;
  px: Uint8Array;
}
const read = (relative: string) => PNG.sync.read(readFileSync(path.join(iconDir, relative)));
const alphaAt = (png: PNG, x: number, y: number) => png.data[(y * png.width + x) * 4 + 3]!;

describe('desktop icons', () => {
  it('committed icons are exactly what the generator produces (run `npm run icon` if this fails)', () => {
    const generated = icons.buildIcons(readFileSync(icons.SOURCE));
    for (const [relative, bytes] of generated)
      expect(readFileSync(path.join(iconDir, relative)).equals(bytes), relative).toBe(true);
    const onDisk = [
      ...readdirSync(iconDir).filter((name) => name.endsWith('.png')),
      ...readdirSync(path.join(iconDir, 'icon.iconset')).map((name) => `icon.iconset/${name}`),
    ].sort();
    expect(onDisk).toEqual([...generated.keys()].sort());
  });

  it('generation is deterministic', () => {
    const source = readFileSync(icons.SOURCE);
    const a = icons.buildIcons(source);
    const b = icons.buildIcons(source);
    for (const [name, bytes] of a) expect(b.get(name)!.equals(bytes), name).toBe(true);
  });

  it('the master is a 1024px full-bleed rounded tile with transparent corners', () => {
    const master = read('icon.png');
    expect([master.width, master.height]).toEqual([icons.MASTER_SIZE, icons.MASTER_SIZE]);
    for (const [x, y] of [
      [0, 0],
      [1023, 0],
      [0, 1023],
      [1023, 1023],
    ] as const)
      expect(alphaAt(master, x, y)).toBe(0);
    expect(alphaAt(master, 512, 512)).toBe(255);
    // Full-bleed: the art reaches the canvas edge along the middle of each side.
    expect(alphaAt(master, 512, 2)).toBeGreaterThan(0);
    expect(alphaAt(master, 2, 512)).toBeGreaterThan(0);
  });

  it('the macOS variant keeps a transparent margin around art scaled to about 80%', () => {
    const mac = read('icon-mac.png');
    const margin = (icons.MASTER_SIZE - icons.MAC_ART_SIZE) / 2;
    expect(mac.width).toBe(icons.MASTER_SIZE);
    for (let i = 0; i < margin - 2; i++) {
      expect(alphaAt(mac, i, 512)).toBe(0);
      expect(alphaAt(mac, 512, i)).toBe(0);
      expect(alphaAt(mac, 1023 - i, 512)).toBe(0);
      expect(alphaAt(mac, 512, 1023 - i)).toBe(0);
    }
    expect(alphaAt(mac, 512, 512)).toBe(255);
  });

  it('the iconset has the ten standard sizes macOS iconutil expects', () => {
    for (const size of icons.ICONSET_SIZES) {
      const normal = read(`icon.iconset/icon_${size}x${size}.png`);
      const retina = read(`icon.iconset/icon_${size}x${size}@2x.png`);
      expect([normal.width, normal.height]).toEqual([size, size]);
      expect([retina.width, retina.height]).toEqual([size * 2, size * 2]);
    }
  });

  it('resampling never leaves dark fringes on transparent edges', () => {
    // A red disc-ish block beside fully transparent BLACK pixels: a non-premultiplied filter would
    // blend the black in and darken the edge; the premultiplied one keeps the red pure.
    const px = new Uint8Array(4 * 4 * 4);
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 4; x++) {
        const opaque = x < 2;
        px.set(opaque ? [255, 0, 0, 255] : [0, 0, 0, 0], (y * 4 + x) * 4);
      }
    const small = icons.resize({ w: 4, h: 4, px }, 1);
    expect(Array.from(small.px.subarray(0, 3))).toEqual([255, 0, 0]);
    expect(small.px[3]).toBe(128);
  });

  it('rejects logos that are not 8-bit RGBA and non-interlaced instead of mis-decoding them', () => {
    const rgb = new PNG({
      width: 2,
      height: 2,
      colorType: 2,
      inputColorType: 6,
      inputHasAlpha: true,
    });
    expect(() => icons.assertSupportedPng(PNG.sync.write(rgb, { colorType: 2 }))).toThrow(/RGBA/);
    expect(() => icons.assertSupportedPng(Buffer.from('not a png at all, definitely'))).toThrow();
    expect(() => icons.assertSupportedPng(readFileSync(icons.SOURCE))).not.toThrow();
  });

  it('the Electrobun config points every platform at generated icons that exist', () => {
    const config = readFileSync(path.join(repo, 'electrobun.config.ts'), 'utf8');
    for (const key of ['icon', 'icons'] as const)
      expect(config).toMatch(new RegExp(`${key}: 'assets/desktop-icons/`));
    expect(config).toContain("icons: 'assets/desktop-icons/icon.iconset'");
    expect(config.match(/icon: 'assets\/desktop-icons\/icon\.png'/g)).toHaveLength(2); // linux + win
    expect(readFileSync(path.join(iconDir, 'icon.png')).length).toBeGreaterThan(0);
  });
});
