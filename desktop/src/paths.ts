import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export function dataRoot(): string {
  return process.env['PIXEL_AGENTS_DATA_DIR'] ?? path.join(os.homedir(), '.pixel-agents');
}
export function desktopRoot(): string {
  return path.join(dataRoot(), 'desktop');
}
export function resourceRoot(): string {
  if (process.env['PIXEL_AGENTS_RESOURCE_DIR']) return process.env['PIXEL_AGENTS_RESOURCE_DIR'];
  // Electrobun launches its runtime from <bundle>/bin while copied resources
  // live at <bundle>/Resources/app. Keep the data-root fallback for tests and
  // non-packaged development tools.
  const bundled = path.resolve(path.dirname(process.execPath), '..', 'Resources', 'app');
  return existsSync(bundled) ? bundled : path.join(dataRoot(), 'resources');
}
export function logRoot(): string {
  return path.join(desktopRoot(), 'logs');
}
