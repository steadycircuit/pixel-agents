import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import { writeFileAtomic } from '../../server/src/persistence/atomicFile.js';

export const DEFAULT_WINDOW = { width: 1280, height: 800 } as const;
export const MIN_WINDOW = { width: 800, height: 600 } as const;
export const WINDOW_SAVE_DEBOUNCE_MS = 250;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface DisplayArea {
  workArea: Rect;
}
export interface WindowState {
  schemaVersion: 1;
  /** Normal (un-maximized) bounds. */
  bounds: Rect;
  maximized: boolean;
}

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** Validates untrusted persisted data; anything malformed yields undefined (use defaults). */
export function parseWindowState(value: unknown): WindowState | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const { schemaVersion, bounds, maximized } = value as Record<string, unknown>;
  if (schemaVersion !== 1 || bounds === null || typeof bounds !== 'object') return undefined;
  const { x, y, width, height } = bounds as Record<string, unknown>;
  if (!finite(x) || !finite(y) || !finite(width) || !finite(height)) return undefined;
  if (width <= 0 || height <= 0) return undefined;
  return { schemaVersion: 1, bounds: { x, y, width, height }, maximized: maximized === true };
}

const overlap = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/**
 * Clamps restored bounds onto a connected display: enforces the minimum size, shrinks to fit the
 * work area, and moves the window fully on-screen. Monitors may sit at negative coordinates, be
 * removed since the last run, or have changed scale; only the display with the greatest overlap
 * (or the primary/first when none overlaps) is used.
 */
export function clampToDisplays(bounds: Rect, displays: readonly DisplayArea[]): Rect {
  const sized = {
    ...bounds,
    width: Math.max(MIN_WINDOW.width, Math.round(bounds.width)),
    height: Math.max(MIN_WINDOW.height, Math.round(bounds.height)),
  };
  if (displays.length === 0) return { ...sized, x: Math.round(bounds.x), y: Math.round(bounds.y) };
  const target =
    displays
      .map((display) => ({ display, area: overlap(sized, display.workArea) }))
      .sort((a, b) => b.area - a.area)[0]?.display ?? displays[0]!;
  const work = target.workArea;
  const width = Math.min(sized.width, Math.max(MIN_WINDOW.width, work.width));
  const height = Math.min(sized.height, Math.max(MIN_WINDOW.height, work.height));
  const x = Math.min(Math.max(Math.round(bounds.x), work.x), work.x + work.width - width);
  const y = Math.min(Math.max(Math.round(bounds.y), work.y), work.y + work.height - height);
  return { x, y, width, height };
}

export function initialFrame(
  state: WindowState | undefined,
  displays: readonly DisplayArea[],
): Rect {
  if (state) return clampToDisplays(state.bounds, displays);
  const work = displays[0]?.workArea ?? { x: 0, y: 0, ...DEFAULT_WINDOW };
  return clampToDisplays(
    {
      width: DEFAULT_WINDOW.width,
      height: DEFAULT_WINDOW.height,
      x: work.x + Math.round((work.width - DEFAULT_WINDOW.width) / 2),
      y: work.y + Math.round((work.height - DEFAULT_WINDOW.height) / 2),
    },
    displays,
  );
}

export async function loadWindowState(root: string): Promise<WindowState | undefined> {
  try {
    return parseWindowState(JSON.parse(await readFile(path.join(root, 'window.json'), 'utf8')));
  } catch {
    return undefined;
  }
}

export async function saveWindowState(root: string, state: WindowState): Promise<void> {
  await writeFileAtomic(path.join(root, 'window.json'), `${JSON.stringify(state, null, 2)}\n`);
}

/** Debounces bounds/maximize changes; `flush` writes any pending state (used at shutdown). */
export function createWindowStateSaver(
  save: (state: WindowState) => Promise<void>,
  delayMs = WINDOW_SAVE_DEBOUNCE_MS,
) {
  let pending: WindowState | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const write = async () => {
    timer = undefined;
    const state = pending;
    pending = undefined;
    if (state) await save(state).catch((error) => console.error('[Desktop] window.json:', error));
  };
  return {
    update(state: WindowState) {
      pending = state;
      if (!timer) timer = setTimeout(() => void write(), delayMs);
    },
    async flush() {
      if (timer) clearTimeout(timer);
      await write();
    },
  };
}
