/**
 * Fitting the office to the window: where its content is, what zoom makes it fill the viewport, and
 * the pan that centres it. Pure and DOM-free (dimensions are passed in) so it is testable in Node.
 *
 * Pan is a device-pixel offset from "the whole grid centred", exactly as `mapOffset` applies it, so
 * centring a world point (px, py) needs pan = (mapW/2 - px*zoom, mapH/2 - py*zoom).
 */
import { ZOOM_FIT_FILL, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP } from '../constants.js';
import { TILE_SIZE, TileType } from './types.js';

export interface ContentBounds {
  /** World (sprite pixel) coordinates of the office content. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Rounds to the nearest zoom step and clamps to the allowed range. */
export function quantizeZoom(zoom: number): number {
  const stepped = Math.round(zoom / ZOOM_STEP) * ZOOM_STEP;
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Number(stepped.toFixed(4))));
}

/**
 * The area the user actually built: the bounding box of every non-VOID tile, not the whole grid
 * (a grid can have large empty margins). Wall sprites draw one tile above their tile, so the top
 * edge grows by a tile when the top row holds walls. Null for an empty layout.
 */
export function contentBounds(
  tiles: readonly number[],
  cols: number,
  rows: number,
): ContentBounds | null {
  let minCol = cols;
  let maxCol = -1;
  let minRow = rows;
  let maxRow = -1;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (tiles[row * cols + col] === TileType.VOID) continue;
      if (col < minCol) minCol = col;
      if (col > maxCol) maxCol = col;
      if (row < minRow) minRow = row;
      if (row > maxRow) maxRow = row;
    }
  }
  if (maxCol < 0) return null;
  let topFace = 0;
  for (let col = minCol; col <= maxCol; col++)
    if (tiles[minRow * cols + col] === TileType.WALL) topFace = TILE_SIZE;
  return {
    x0: minCol * TILE_SIZE,
    y0: minRow * TILE_SIZE - topFace,
    x1: (maxCol + 1) * TILE_SIZE,
    y1: (maxRow + 1) * TILE_SIZE,
  };
}

/** Largest zoom step at which the content fits the viewport with a margin (never below the floor). */
export function fitZoom(bounds: ContentBounds, viewW: number, viewH: number): number {
  const width = bounds.x1 - bounds.x0;
  const height = bounds.y1 - bounds.y0;
  if (width <= 0 || height <= 0 || viewW <= 0 || viewH <= 0) return quantizeZoom(ZOOM_MIN);
  const fit = Math.min(viewW / width, viewH / height) * ZOOM_FIT_FILL;
  const stepped = Math.floor(fit / ZOOM_STEP + 1e-9) * ZOOM_STEP;
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Number(stepped.toFixed(4))));
}

/** The pan that puts the content's centre at the viewport's centre at this zoom. */
export function centeringPan(
  bounds: ContentBounds,
  cols: number,
  rows: number,
  zoom: number,
): { x: number; y: number } {
  const centerX = (bounds.x0 + bounds.x1) / 2;
  const centerY = (bounds.y0 + bounds.y1) / 2;
  return {
    x: (cols * TILE_SIZE * zoom) / 2 - centerX * zoom,
    y: (rows * TILE_SIZE * zoom) / 2 - centerY * zoom,
  };
}

/** Keeps the same world point at the viewport centre when the zoom changes. */
export function scalePan(
  pan: { x: number; y: number },
  fromZoom: number,
  toZoom: number,
): { x: number; y: number } {
  if (fromZoom <= 0 || fromZoom === toZoom) return pan;
  const ratio = toZoom / fromZoom;
  return { x: pan.x * ratio, y: pan.y * ratio };
}
