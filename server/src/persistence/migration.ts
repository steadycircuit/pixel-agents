import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, cp, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import * as path from 'node:path';

import { writeFileAtomic } from './atomicFile.js';
import {
  buildDesktopGeneration,
  type DesktopGeneration,
  inspectLegacySources,
  type LegacyInventory,
} from './legacyImport.js';
import { DESKTOP_SCHEMA_VERSION, MigrationError } from './profileTypes.js';

/**
 * First-run import of the legacy `~/.pixel-agents` files into the desktop profile.
 *
 * Transaction outline (each arrow is a durable step; a crash anywhere is recoverable):
 *
 *   backup + verify -> journal(staging) -> stage files -> journal(committing, hashes)
 *     -> rename config/state/layout into place -> migration.json marker -> remove journal + stage
 *
 * `staging` crashes are discarded and restarted from the untouched sources. `committing` crashes
 * are rolled FORWARD from the hash-verified staged files. A profile is only ever one generation.
 */
export const MIGRATION_STEPS = [
  'backup',
  'journal-staging',
  'stage',
  'journal-committing',
  'commit-config',
  'commit-state',
  'commit-layout',
  'marker',
  'cleanup',
] as const;
export type MigrationStep = (typeof MIGRATION_STEPS)[number];

export interface MigrationOptions {
  /** Called before each step; a test throws here to simulate a crash at that boundary. */
  beforeStep?: (step: MigrationStep) => void | Promise<void>;
  now?: () => number;
}
export interface MigrationOutcome {
  status: 'skipped' | 'migrated' | 'recovered';
  markerPath: string;
}

const FILES = ['config.json', 'state.json', 'layout.json'] as const;
type ProfileFile = (typeof FILES)[number];

interface Journal {
  schemaVersion: 1;
  id: string;
  phase: 'staging' | 'committing';
  backup: string;
  staging: string;
  /** Hash of each staged file, recorded once staging is complete. */
  hashes?: Record<ProfileFile, string>;
  sources: Array<{ path: string; hash: string | null }>;
}

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const exists = (file: string) =>
  access(file, constants.F_OK).then(
    () => true,
    () => false,
  );

async function readJsonFile<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export function migrationPaths(root: string) {
  return {
    marker: path.join(root, 'migration.json'),
    journal: path.join(root, 'migration.journal.json'),
    backups: path.join(root, 'backups'),
  };
}

export async function migrateProfile(
  root: string,
  options: MigrationOptions = {},
): Promise<MigrationOutcome> {
  const paths = migrationPaths(root);
  const step = async (name: MigrationStep) => options.beforeStep?.(name);

  const marker = await readJsonFile<{ schemaVersion?: number }>(paths.marker);
  if (marker) {
    if ((marker.schemaVersion ?? 0) > DESKTOP_SCHEMA_VERSION)
      throw new MigrationError(
        'UNSUPPORTED_SCHEMA',
        'This profile was written by a newer Pixel Agents. Update the app; nothing was changed.',
      );
    await removeLeftovers(root, paths.journal);
    return { status: 'skipped', markerPath: paths.marker };
  }

  const journal = await readJsonFile<Journal>(paths.journal);
  if (journal?.phase === 'committing') {
    await rollForward(root, journal, options, paths.marker, paths.journal);
    return { status: 'recovered', markerPath: paths.marker };
  }
  if (journal) await rm(journal.staging, { recursive: true, force: true });

  // A profile that already holds all three valid files predates the marker (a development
  // profile); it is complete, so it is left exactly as it is.
  const present = await Promise.all(FILES.map((name) => exists(path.join(root, name))));
  if (present.every(Boolean)) return { status: 'skipped', markerPath: paths.marker };

  const legacyRoot = path.dirname(root);
  const inventory = await inspectLegacySources(legacyRoot);
  const generation = buildDesktopGeneration(inventory); // throws on corrupt sources: no writes yet

  const id = `${(options.now ?? Date.now)()}-${randomUUID()}`;
  const backup = path.join(paths.backups, id);
  const staging = path.join(root, `.migration-staging-${id}`);
  const sources = sourceRecords(inventory);

  await step('backup');
  await backUp(root, backup, inventory);

  await step('journal-staging');
  await writeJournal(paths.journal, { id, phase: 'staging', backup, staging, sources });

  await step('stage');
  await mkdir(staging, { recursive: true, mode: 0o700 });
  const hashes = await stageGeneration(staging, generation);

  await step('journal-committing');
  const committing: Journal = {
    schemaVersion: 1,
    id,
    phase: 'committing',
    backup,
    staging,
    hashes,
    sources,
  };
  await writeFileAtomic(paths.journal, JSON.stringify(committing, null, 2));

  await finish(root, committing, generation.diagnostics, options, paths.marker, paths.journal);
  return { status: 'migrated', markerPath: paths.marker };
}

function sourceRecords(inventory: LegacyInventory) {
  return [inventory.config, inventory.standaloneState, inventory.vscodeState, inventory.layout].map(
    (source) => ({ path: source.path, hash: source.hash }),
  );
}

async function writeJournal(
  file: string,
  fields: Omit<Journal, 'schemaVersion' | 'hashes'>,
): Promise<void> {
  await writeFileAtomic(file, JSON.stringify({ schemaVersion: 1, ...fields }, null, 2));
}

/**
 * Copies every source (and any pre-existing partial desktop files) into the backup directory and
 * verifies each copy by hash. A failed backup aborts before anything in the profile is replaced.
 */
async function backUp(root: string, backup: string, inventory: LegacyInventory): Promise<void> {
  try {
    await mkdir(backup, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new MigrationError(
      'BACKUP_FAILED',
      `Could not create the backup directory (${(error as Error).message}); nothing was changed.`,
    );
  }
  const candidates = [
    inventory.config,
    inventory.standaloneState,
    inventory.vscodeState,
    inventory.layout,
  ]
    .filter((source) => source.exists)
    .map((source) => ({ from: source.path, hash: source.hash }));
  for (const name of FILES) {
    const file = path.join(root, name);
    if (await exists(file)) {
      const bytes = await readFile(file);
      candidates.push({ from: file, hash: sha256(bytes) });
    }
  }
  for (const { from, hash } of candidates) {
    // Desktop files share basenames with legacy ones (config.json, layout.json), so they go under
    // `previous-desktop/`.
    const target = from.startsWith(root + path.sep)
      ? path.join(backup, 'previous-desktop', path.basename(from))
      : path.join(backup, path.basename(from));
    try {
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await cp(from, target);
      if (sha256(await readFile(target)) !== hash) throw new Error('checksum mismatch');
    } catch (error) {
      throw new MigrationError(
        'BACKUP_FAILED',
        `Could not back up ${path.basename(from)} (${(error as Error).message}); nothing was changed.`,
      );
    }
  }
}

async function stageGeneration(
  staging: string,
  generation: DesktopGeneration,
): Promise<Record<ProfileFile, string>> {
  const contents: Record<ProfileFile, string> = {
    'config.json': `${JSON.stringify(generation.config, null, 2)}\n`,
    'state.json': `${JSON.stringify(generation.state, null, 2)}\n`,
    'layout.json': `${JSON.stringify(generation.layout, null, 2)}\n`,
  };
  const hashes = {} as Record<ProfileFile, string>;
  for (const name of FILES) {
    await writeFileAtomic(path.join(staging, name), contents[name]);
    hashes[name] = sha256(contents[name]);
  }
  return hashes;
}

async function finish(
  root: string,
  journal: Journal,
  diagnostics: DesktopGeneration['diagnostics'] | undefined,
  options: MigrationOptions,
  markerPath: string,
  journalPath: string,
): Promise<void> {
  const step = async (name: MigrationStep) => options.beforeStep?.(name);
  const names: Record<ProfileFile, MigrationStep> = {
    'config.json': 'commit-config',
    'state.json': 'commit-state',
    'layout.json': 'commit-layout',
  };
  for (const name of FILES) {
    await step(names[name]);
    await commitFile(root, journal, name);
  }
  await step('marker');
  await writeFileAtomic(
    markerPath,
    JSON.stringify(
      {
        schemaVersion: DESKTOP_SCHEMA_VERSION,
        migrationId: journal.id,
        completedAt: (options.now ?? Date.now)(),
        sources: journal.sources,
        backup: journal.backup,
        files: journal.hashes,
        diagnostics,
      },
      null,
      2,
    ),
  );
  await step('cleanup');
  await removeLeftovers(root, journalPath, journal.staging);
}

/** Idempotent: a file already renamed into place (matching hash) is left alone. */
async function commitFile(root: string, journal: Journal, name: ProfileFile): Promise<void> {
  const expected = journal.hashes?.[name];
  const target = path.join(root, name);
  const staged = path.join(journal.staging, name);
  if (expected && (await exists(target)) && sha256(await readFile(target)) === expected) return;
  if (!expected || !(await exists(staged)) || sha256(await readFile(staged)) !== expected)
    throw new MigrationError(
      'RECOVERY_FAILED',
      `Interrupted migration cannot be completed: staged ${name} is missing or altered. ` +
        `Originals are preserved in ${journal.backup}.`,
    );
  await rename(staged, target);
}

async function rollForward(
  root: string,
  journal: Journal,
  options: MigrationOptions,
  markerPath: string,
  journalPath: string,
): Promise<void> {
  await finish(root, journal, undefined, options, markerPath, journalPath);
}

async function removeLeftovers(root: string, journalPath: string, staging?: string) {
  await rm(journalPath, { force: true });
  if (staging) await rm(staging, { recursive: true, force: true });
  else {
    for (const entry of await readdir(root))
      if (entry.startsWith('.migration-staging-'))
        await rm(path.join(root, entry), { recursive: true, force: true });
  }
}
