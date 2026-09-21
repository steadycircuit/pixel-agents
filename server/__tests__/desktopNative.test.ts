import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLogger, redactText, redactValue } from '../../desktop/src/logging.js';
import {
  clampToDisplays,
  createWindowStateSaver,
  initialFrame,
  loadWindowState,
  MIN_WINDOW,
  parseWindowState,
  saveWindowState,
} from '../../desktop/src/windowState.js';

const roots: string[] = [];
const tmp = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pixel-native-'));
  roots.push(root);
  return root;
};
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('log redaction', () => {
  it('removes credentials and personal paths from text', () => {
    const text = redactText(
      'Authorization: Bearer abcdefghijklmnop token=supersecretvalue in /home/ed/project',
      '/home/ed',
    );
    expect(text).not.toContain('abcdefghijklmnop');
    expect(text).not.toContain('supersecretvalue');
    expect(text).toContain('~/project');
  });

  it('never logs prompts, transcripts or tokens carried in structured fields', () => {
    const redacted = redactValue(
      {
        operationId: 'op-1',
        initialPrompt: 'refactor my secret project',
        nested: { transcript: 'user said things', token: 'abc', ok: 'keep me' },
        list: [{ prompt: 'x' }],
      },
      '/home/ed',
    ) as Record<string, any>;
    expect(JSON.stringify(redacted)).not.toMatch(/secret project|user said|"abc"/);
    expect(redacted.operationId).toBe('op-1');
    expect(redacted.nested.ok).toBe('keep me');
  });
});

describe('rotating log', () => {
  it('writes structured lines with correlation context', async () => {
    const dir = await tmp();
    const logger = createLogger({
      dir,
      home: '/home/ed',
      context: { appVersion: '1.2.3', instanceId: 'inst-1' },
    });
    logger.log('info', 'started', { operationId: 'op-9', prompt: 'nope' });
    await logger.flush();
    const [line] = (await readFile(logger.file, 'utf8')).trim().split('\n');
    expect(JSON.parse(line!)).toMatchObject({
      level: 'info',
      appVersion: '1.2.3',
      instanceId: 'inst-1',
      message: 'started',
      fields: { operationId: 'op-9', prompt: '[redacted]' },
    });
  });

  it('keeps at most five files of bounded size, dropping the oldest', async () => {
    const dir = await tmp();
    const logger = createLogger({ dir, maxBytes: 400, maxFiles: 5 });
    for (let index = 0; index < 60; index++) logger.log('info', `entry ${index} ${'x'.repeat(60)}`);
    await logger.flush();
    const files = (await readdir(dir)).sort();
    expect(files.length).toBeLessThanOrEqual(5);
    for (const name of files) expect((await stat(path.join(dir, name))).size).toBeLessThan(1_000);
    expect(await readFile(logger.file, 'utf8')).toContain('entry 59');
  });

  it('survives an unwritable directory without throwing', async () => {
    const dir = await tmp();
    await writeFile(path.join(dir, 'blocked'), 'a file');
    const logger = createLogger({ dir: path.join(dir, 'blocked', 'logs') });
    expect(() => logger.log('error', 'still fine')).not.toThrow();
    await expect(logger.flush()).resolves.toBeUndefined();
  });
});

const display = (x: number, y: number, width: number, height: number) => ({
  workArea: { x, y, width, height },
});

describe('window state', () => {
  it('rejects malformed persisted state', () => {
    for (const bad of [
      null,
      'x',
      {},
      { schemaVersion: 2, bounds: { x: 0, y: 0, width: 1, height: 1 } },
      { schemaVersion: 1, bounds: { x: NaN, y: 0, width: 900, height: 700 } },
      { schemaVersion: 1, bounds: { x: 0, y: 0, width: -5, height: 700 } },
      { schemaVersion: 1, bounds: { x: 0, y: 0, width: Infinity, height: 700 } },
    ])
      expect(parseWindowState(bad)).toBeUndefined();
    expect(
      parseWindowState({ schemaVersion: 1, bounds: { x: 1, y: 2, width: 900, height: 700 } }),
    ).toEqual({
      schemaVersion: 1,
      bounds: { x: 1, y: 2, width: 900, height: 700 },
      maximized: false,
    });
  });

  it('moves a window from a removed monitor onto the remaining one', () => {
    const only = [display(0, 0, 1920, 1080)];
    expect(clampToDisplays({ x: 3000, y: 200, width: 1000, height: 700 }, only)).toEqual({
      x: 920,
      y: 200,
      width: 1000,
      height: 700,
    });
  });

  it('supports monitors at negative coordinates', () => {
    const left = [display(-1920, 0, 1920, 1080), display(0, 0, 1920, 1080)];
    expect(clampToDisplays({ x: -1500, y: 100, width: 1000, height: 700 }, left)).toEqual({
      x: -1500,
      y: 100,
      width: 1000,
      height: 700,
    });
  });

  it('shrinks to a smaller display, never below the minimum size', () => {
    const small = [display(0, 0, 1024, 700)];
    const clamped = clampToDisplays({ x: 0, y: 0, width: 3000, height: 3000 }, small);
    expect(clamped.width).toBe(1024);
    expect(clamped.height).toBe(700);
    const tiny = clampToDisplays({ x: 0, y: 0, width: 10, height: 10 }, small);
    expect(tiny.width).toBe(MIN_WINDOW.width);
    expect(tiny.height).toBe(MIN_WINDOW.height);
  });

  it('centres the default window on the first display when nothing was saved', () => {
    expect(initialFrame(undefined, [display(0, 0, 2560, 1440)])).toEqual({
      x: 640,
      y: 320,
      width: 1280,
      height: 800,
    });
  });

  it('persists and restores atomically, ignoring a corrupt file', async () => {
    const root = await tmp();
    expect(await loadWindowState(root)).toBeUndefined();
    const state = {
      schemaVersion: 1 as const,
      bounds: { x: 10, y: 20, width: 1000, height: 700 },
      maximized: true,
    };
    await saveWindowState(root, state);
    expect(await loadWindowState(root)).toEqual(state);
    await writeFile(path.join(root, 'window.json'), '{broken');
    expect(await loadWindowState(root)).toBeUndefined();
  });

  it('debounces rapid changes to one write and flushes pending state on demand', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => undefined);
    const saver = createWindowStateSaver(save, 250);
    const at = (x: number) => ({
      schemaVersion: 1 as const,
      bounds: { x, y: 0, width: 900, height: 700 },
      maximized: false,
    });
    saver.update(at(1));
    saver.update(at(2));
    saver.update(at(3));
    await vi.advanceTimersByTimeAsync(249);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(at(3));
    saver.update(at(4));
    await saver.flush();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith(at(4));
  });
});
