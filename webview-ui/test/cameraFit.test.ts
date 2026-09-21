import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { ZOOM_MAX, ZOOM_MIN, ZOOM_STEP } from '../src/constants.js';
import {
  centeringPan,
  contentBounds,
  fitZoom,
  quantizeZoom,
  scalePan,
} from '../src/office/cameraFit.js';
import { mapOffset } from '../src/office/projection.js';
import { TILE_SIZE, TileType } from '../src/office/types.js';

const V = TileType.VOID;
const F = TileType.FLOOR_1;
const W = TileType.WALL;

describe('zoom steps', () => {
  test('are four times finer than whole numbers', () => {
    assert.equal(ZOOM_STEP, 0.25);
    assert.equal(quantizeZoom(2.13), 2.25);
    assert.equal(quantizeZoom(2.1), 2);
    assert.equal(quantizeZoom(6), 6);
    assert.equal(quantizeZoom(0.01), ZOOM_MIN);
    assert.equal(quantizeZoom(99), ZOOM_MAX);
  });
});

describe('contentBounds', () => {
  test('ignores empty grid margins and covers only built tiles', () => {
    // 5x4 grid, content in cols 1-2, rows 1-2
    const tiles = [V, V, V, V, V, V, F, F, V, V, V, F, F, V, V, V, V, V, V, V];
    assert.deepEqual(contentBounds(tiles, 5, 4), {
      x0: TILE_SIZE,
      y0: TILE_SIZE,
      x1: 3 * TILE_SIZE,
      y1: 3 * TILE_SIZE,
    });
  });

  test('grows the top edge by a tile when the top row is wall (the wall face draws above it)', () => {
    // 4x3 grid: row 0 = wall, row 1 = floor, row 2 = empty
    const tiles = [W, W, V, V, F, F, V, V, V, V, V, V];
    assert.deepEqual(contentBounds(tiles, 4, 3), {
      x0: 0,
      y0: -TILE_SIZE,
      x1: 2 * TILE_SIZE,
      y1: 2 * TILE_SIZE,
    });
    // ...but not when the top row is floor.
    assert.equal(contentBounds([F, F, V, V, F, F, V, V, V, V, V, V], 4, 3)!.y0, 0);
  });

  test('is null for an empty layout', () => {
    assert.equal(contentBounds([V, V, V, V], 2, 2), null);
  });
});

describe('fitZoom', () => {
  const bounds = { x0: 0, y0: 0, x1: 336, y1: 352 };
  test('fills the smaller dimension with a margin, on a quarter step, never overflowing', () => {
    const zoom = fitZoom(bounds, 1280, 800);
    assert.equal(zoom % ZOOM_STEP, 0);
    assert.ok(zoom * 336 <= 1280 && zoom * 352 <= 800);
    assert.ok(zoom * 352 >= 800 * 0.8, 'uses most of the height');
  });
  test('shrinks and grows with the window', () => {
    assert.ok(fitZoom(bounds, 640, 400) < fitZoom(bounds, 1280, 800));
    assert.ok(fitZoom(bounds, 2560, 1600) > fitZoom(bounds, 1280, 800));
  });
  test('respects the zoom limits and degenerate input', () => {
    assert.equal(fitZoom(bounds, 10, 10), ZOOM_MIN);
    assert.equal(fitZoom({ x0: 0, y0: 0, x1: 16, y1: 16 }, 9000, 9000), ZOOM_MAX);
    assert.equal(fitZoom(bounds, 0, 800), ZOOM_MIN);
  });
});

describe('centeringPan', () => {
  test('puts the content centre at the viewport centre, for any zoom', () => {
    const cols = 21;
    const rows = 22;
    // Content sits low and to the right inside the grid.
    const bounds = { x0: 4 * TILE_SIZE, y0: 8 * TILE_SIZE, x1: 20 * TILE_SIZE, y1: 22 * TILE_SIZE };
    for (const zoom of [0.5, 1.25, 2.75, 6]) {
      const viewW = 1200;
      const viewH = 800;
      const pan = centeringPan(bounds, cols, rows, zoom);
      const { offsetX, offsetY } = mapOffset(viewW, viewH, cols, rows, zoom, pan.x, pan.y);
      const centreX = offsetX + ((bounds.x0 + bounds.x1) / 2) * zoom;
      const centreY = offsetY + ((bounds.y0 + bounds.y1) / 2) * zoom;
      // mapOffset snaps to whole device pixels, so allow one pixel.
      assert.ok(Math.abs(centreX - viewW / 2) <= 1.5, `x at zoom ${zoom}: ${centreX}`);
      assert.ok(Math.abs(centreY - viewH / 2) <= 1.5, `y at zoom ${zoom}: ${centreY}`);
    }
  });

  test('a centred grid needs no pan', () => {
    const bounds = { x0: 0, y0: 0, x1: 10 * TILE_SIZE, y1: 6 * TILE_SIZE };
    assert.deepEqual(centeringPan(bounds, 10, 6, 3), { x: 0, y: 0 });
  });
});

describe('scalePan', () => {
  test('keeps the same world point under the viewport centre when zoom changes', () => {
    assert.deepEqual(scalePan({ x: 100, y: -40 }, 2, 4), { x: 200, y: -80 });
    assert.deepEqual(scalePan({ x: 100, y: -40 }, 2, 2), { x: 100, y: -40 });
  });
});
