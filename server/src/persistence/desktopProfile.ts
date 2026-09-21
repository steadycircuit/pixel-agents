import { readFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';

import { writeFileAtomic } from './atomicFile.js';
import { migrateProfile, type MigrationOptions } from './migration.js';
import {
  DEFAULT_SETTINGS,
  DESKTOP_SCHEMA_VERSION,
  type DesktopConfig,
  type DesktopLayout,
  type DesktopProfile,
  type DesktopState,
  MigrationError,
} from './profileTypes.js';

export { DESKTOP_SCHEMA_VERSION, MigrationError };
export type { DesktopConfig, DesktopLayout, DesktopProfile, DesktopState };

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function desktopRoot(
  dataRoot = process.env['PIXEL_AGENTS_DATA_DIR'] ?? path.join(homedir(), '.pixel-agents'),
): string {
  return path.join(dataRoot, 'desktop');
}

async function loadFile<T>(root: string, name: string): Promise<T> {
  let text: string;
  try {
    text = await readFile(path.join(root, name), 'utf8');
  } catch (error) {
    throw new Error(`Desktop profile is incomplete: ${name} is unreadable (${error})`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Desktop profile contains unreadable ${name}: ${(error as Error).message}`);
  }
  if (!isObject(value)) throw new Error(`Desktop profile contains unreadable ${name}`);
  if (typeof value['schemaVersion'] === 'number' && value['schemaVersion'] > DESKTOP_SCHEMA_VERSION)
    throw new MigrationError(
      'UNSUPPORTED_SCHEMA',
      `${name} was written by a newer Pixel Agents (schema ${value['schemaVersion']}). ` +
        'Update the app; nothing was changed.',
    );
  return value as T;
}

export interface OpenProfileOptions {
  migration?: MigrationOptions;
}

export async function openDesktopProfile(
  root = desktopRoot(),
  options: OpenProfileOptions = {},
): Promise<DesktopProfile> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await migrateProfile(root, options.migration);
  const [config, state, layout] = await Promise.all([
    loadFile<DesktopConfig>(root, 'config.json'),
    loadFile<DesktopState>(root, 'state.json'),
    loadFile<DesktopLayout>(root, 'layout.json'),
  ]);
  const settings = isObject(config.settings) ? config.settings : DEFAULT_SETTINGS;
  config.settings = {
    ...DEFAULT_SETTINGS,
    ...settings,
    hooksEnabled: { ...DEFAULT_SETTINGS.hooksEnabled, ...settings.hooksEnabled },
    providerExecutables: { ...settings.providerExecutables },
    workspaces: Array.isArray(settings.workspaces) ? settings.workspaces : [],
  };
  state.agents = Array.isArray(state.agents) ? state.agents : [];
  state.seats = isObject(state.seats) ? state.seats : {};
  state.dismissed = Array.isArray(state.dismissed) ? state.dismissed : [];
  state.legacyDismissed = Array.isArray(state.legacyDismissed) ? state.legacyDismissed : [];
  state.seatsRevision ??= 0;
  layout.layoutRevision ??= 0;
  return { root, config, state, layout };
}

/** Each file is replaced durably and atomically; failures propagate to the caller. */
export async function writeDesktopProfile(profile: DesktopProfile): Promise<void> {
  for (const [name, value] of [
    ['config.json', profile.config],
    ['state.json', profile.state],
    ['layout.json', profile.layout],
  ] as const)
    await writeFileAtomic(path.join(profile.root, name), `${JSON.stringify(value, null, 2)}\n`);
}
