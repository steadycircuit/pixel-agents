import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { writeFileAtomic } from '../src/persistence/atomicFile.js';
import { openDesktopProfile } from '../src/persistence/desktopProfile.js';
import { MIGRATION_STEPS, type MigrationStep } from '../src/persistence/migration.js';
import { MigrationError } from '../src/persistence/profileTypes.js';
import { createProviderRegistry } from '../src/providerRegistry.js';
import { claudeProvider, codexProvider } from '../src/providers/index.js';
import { createRuntimeHost } from '../src/runtimeHost.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await chmod(root, 0o700).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }),
  );
});

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

async function legacyHome(files: Record<string, unknown> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pixel-migration-'));
  roots.push(root);
  const write = (name: string, value: unknown) =>
    writeFile(path.join(root, name), typeof value === 'string' ? value : JSON.stringify(value));
  await Promise.all(Object.entries(files).map(([name, value]) => write(name, value)));
  return { root, desktop: path.join(root, 'desktop'), write };
}

const fullLegacy = {
  'config.json': {
    standalone: { soundEnabled: false },
    hooksEnabled: { claude: true, codex: false },
    hooksConsent: { claude: 'granted' },
    externalAssetDirectories: ['/assets/extra'],
    dismissedSessionIds: ['known-1', 'orphan'],
  },
  'standalone-state.json': {
    agents: [
      { id: 1, sessionId: 'known-1', jsonlFile: '/home/u/.claude/projects/p/known-1.jsonl' },
      { id: 2, sessionId: 'codex-2', jsonlFile: '/home/u/.codex/sessions/codex-2.jsonl' },
      { id: 3, sessionId: 'mystery', jsonlFile: '/somewhere/else.jsonl' },
    ],
    seats: {
      1: { palette: 1, seatId: 'chair-a' },
      2: { palette: 2, seatId: 'chair-a' },
      9: { palette: 3, seatId: 'chair-z' },
    },
  },
  'layout.json': { version: 1, cols: 3, tiles: [0, 0, 0], areas: [{ label: 'x' }] },
};

const desktopFiles = ['config.json', 'state.json', 'layout.json'];
async function snapshotProfile(desktop: string) {
  return Object.fromEntries(
    await Promise.all(
      desktopFiles.map(async (name) => [name, await readFile(path.join(desktop, name), 'utf8')]),
    ),
  );
}
const legacyHashes = async (root: string) =>
  Object.fromEntries(
    await Promise.all(
      Object.keys(fullLegacy).map(async (name) => [
        name,
        sha(await readFile(path.join(root, name))),
      ]),
    ),
  );

describe('legacy import rules', () => {
  it('imports on evidence: provider from transcript root, ambiguous excluded, seats deduped', async () => {
    const { root, desktop } = await legacyHome(fullLegacy);
    const profile = await openDesktopProfile(desktop);

    expect(profile.state.agents.map((a) => a.sessionKey)).toEqual([
      { providerId: 'claude', sessionId: 'known-1' },
      { providerId: 'codex', sessionId: 'codex-2' },
    ]);
    // Contested seat: the earlier agent keeps it, the later one is unseated but keeps its palette.
    expect(profile.state.seats).toEqual({
      'claude:known-1': { palette: 1, seatId: 'chair-a' },
      'codex:codex-2': { palette: 2 },
    });
    expect(profile.state.dismissed).toEqual(['claude:known-1']);
    expect(profile.state.legacyDismissed).toEqual(['orphan']);
    expect(profile.layout.layout).toEqual(fullLegacy['layout.json']);
    expect(profile.config.hooksConsent).toEqual({ claude: 'granted' });
    expect(profile.config.externalAssetDirectories).toEqual(['/assets/extra']);

    const marker = JSON.parse(await readFile(path.join(desktop, 'migration.json'), 'utf8'));
    expect(marker.diagnostics.ambiguousAgents).toHaveLength(1);
    expect(marker.diagnostics.unmatchedSeats).toEqual(['9']);
    expect(marker.diagnostics.displacedSeats).toEqual(['codex:codex-2']);
    expect(await legacyHashes(root)).toEqual(
      Object.fromEntries(
        Object.entries(fullLegacy).map(([name, value]) => [name, sha(JSON.stringify(value))]),
      ),
    );
  });

  it('never turns unanswered consent into granted', async () => {
    const { desktop } = await legacyHome({ 'config.json': { hooksEnabled: { claude: true } } });
    expect((await openDesktopProfile(desktop)).config.hooksConsent).toBeUndefined();
  });

  it('prefers standalone state and only falls back to the VS Code state when it is absent', async () => {
    const claude = (id: string) => ({
      agents: [{ id: 1, sessionId: id, jsonlFile: '/h/.claude/p/x.jsonl' }],
    });
    const both = await legacyHome({
      'standalone-state.json': claude('from-standalone'),
      'vscode-state.json': claude('from-vscode'),
    });
    expect((await openDesktopProfile(both.desktop)).state.agents[0].sessionKey.sessionId).toBe(
      'from-standalone',
    );
    const only = await legacyHome({ 'vscode-state.json': claude('from-vscode') });
    expect((await openDesktopProfile(only.desktop)).state.agents[0].sessionKey.sessionId).toBe(
      'from-vscode',
    );
  });

  it('refuses a corrupt preferred source instead of silently falling back, changing nothing', async () => {
    const home = await legacyHome({
      'standalone-state.json': '{not json',
      'vscode-state.json': { agents: [{ id: 1, sessionId: 'x', jsonlFile: '/h/.claude/x' }] },
    });
    await expect(openDesktopProfile(home.desktop)).rejects.toMatchObject({
      code: 'SOURCE_CORRUPT',
    });
    expect(await readdir(home.desktop)).toEqual([]);
  });

  it('does not treat a missing or wrong-typed layout as a reason to reset it', async () => {
    const home = await legacyHome({ 'layout.json': [1, 2, 3] });
    await expect(openDesktopProfile(home.desktop)).rejects.toBeInstanceOf(MigrationError);
  });
});

describe('migration transaction', () => {
  it('is idempotent: a second open changes nothing and adds no backups', async () => {
    const { desktop } = await legacyHome(fullLegacy);
    await openDesktopProfile(desktop);
    const first = await snapshotProfile(desktop);
    const backups = await readdir(path.join(desktop, 'backups'));
    await openDesktopProfile(desktop);
    expect(await snapshotProfile(desktop)).toEqual(first);
    expect(await readdir(path.join(desktop, 'backups'))).toEqual(backups);
  });

  it('backs every source up with a verified checksum before replacing anything', async () => {
    const { desktop } = await legacyHome(fullLegacy);
    await openDesktopProfile(desktop);
    const [id] = await readdir(path.join(desktop, 'backups'));
    for (const [name, value] of Object.entries(fullLegacy))
      expect(sha(await readFile(path.join(desktop, 'backups', id, name)))).toBe(
        sha(JSON.stringify(value)),
      );
  });

  it.each(MIGRATION_STEPS)('recovers from a crash before step %s', async (crashAt) => {
    const reference = await legacyHome(fullLegacy);
    await openDesktopProfile(reference.desktop);
    const expected = await snapshotProfile(reference.desktop);

    const { root, desktop } = await legacyHome(fullLegacy);
    let crashed = false;
    await expect(
      openDesktopProfile(desktop, {
        migration: {
          beforeStep: (step: MigrationStep) => {
            if (step === crashAt && !crashed) {
              crashed = true;
              throw new Error(`simulated crash before ${step}`);
            }
          },
        },
      }),
    ).rejects.toThrow('simulated crash');

    // A crash never leaves an unexplained mix of generations: a partial set of files is only
    // possible mid-commit, and then a committing journal is what lets recovery finish it.
    const present = (await readdir(desktop)).filter((n) => desktopFiles.includes(n));
    if (present.length > 0 && present.length < 3) {
      const journal = JSON.parse(
        await readFile(path.join(desktop, 'migration.journal.json'), 'utf8'),
      );
      expect(journal.phase).toBe('committing');
    }

    const recovered = await openDesktopProfile(desktop);
    expect(recovered.state.agents).toHaveLength(2);
    // Logical data is identical to an uninterrupted migration (backups/markers differ by id/time).
    expect(await snapshotProfile(desktop)).toEqual(expected);
    const leftovers = (await readdir(desktop)).filter(
      (n) => n.startsWith('.migration-staging-') || n === 'migration.journal.json',
    );
    expect(leftovers).toEqual([]);
    expect(await stat(path.join(desktop, 'migration.json'))).toBeTruthy();
    expect(await legacyHashes(root)).toEqual(
      Object.fromEntries(
        Object.entries(fullLegacy).map(([name, value]) => [name, sha(JSON.stringify(value))]),
      ),
    );
  });

  it('aborts before touching the profile when the backup cannot be made', async () => {
    const home = await legacyHome(fullLegacy);
    await mkdir(home.desktop, { recursive: true });
    await writeFile(path.join(home.desktop, 'backups'), 'a file where the directory should be');
    await expect(openDesktopProfile(home.desktop)).rejects.toMatchObject({
      code: 'BACKUP_FAILED',
    });
    expect((await readdir(home.desktop)).filter((n) => desktopFiles.includes(n))).toEqual([]);
  });

  it('refuses to finish a committing journal whose staged files were altered', async () => {
    const home = await legacyHome(fullLegacy);
    await expect(
      openDesktopProfile(home.desktop, {
        migration: {
          beforeStep: (step) => {
            if (step === 'commit-config') throw new Error('crash');
          },
        },
      }),
    ).rejects.toThrow('crash');
    const staging = (await readdir(home.desktop)).find((n) => n.startsWith('.migration-staging-'))!;
    await writeFile(path.join(home.desktop, staging, 'state.json'), '{"tampered":true}');
    await expect(openDesktopProfile(home.desktop)).rejects.toMatchObject({
      code: 'RECOVERY_FAILED',
    });
  });
});

describe('schema versions', () => {
  it('opens no newer profile for writing and leaves its bytes untouched', async () => {
    const home = await legacyHome();
    const profile = await openDesktopProfile(home.desktop);
    const config = path.join(home.desktop, 'config.json');
    const newer = JSON.stringify({ ...profile.config, schemaVersion: 2, future: true });
    await writeFile(config, newer);
    await expect(openDesktopProfile(home.desktop)).rejects.toMatchObject({
      code: 'UNSUPPORTED_SCHEMA',
    });
    expect(await readFile(config, 'utf8')).toBe(newer);
  });

  it('rejects a marker written by a newer schema', async () => {
    const home = await legacyHome();
    await openDesktopProfile(home.desktop);
    const marker = path.join(home.desktop, 'migration.json');
    await writeFile(marker, JSON.stringify({ schemaVersion: 9 }));
    await expect(openDesktopProfile(home.desktop)).rejects.toMatchObject({
      code: 'UNSUPPORTED_SCHEMA',
    });
  });
});

describe('durable writes', () => {
  it('propagates failures and leaves the previous file and no temp files behind', async () => {
    const { root } = await legacyHome();
    const file = path.join(root, 'data.json');
    await writeFileAtomic(file, 'original');
    await mkdir(path.join(root, 'dir-in-the-way'));
    await expect(writeFileAtomic(path.join(root, 'dir-in-the-way'), 'x')).rejects.toThrow();
    await expect(writeFileAtomic(path.join(root, 'missing', 'f.json'), 'x')).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe('original');
    expect((await readdir(root)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('creates files owner-only', async () => {
    const { root } = await legacyHome();
    const file = path.join(root, 'secret.json');
    await writeFileAtomic(file, '{}');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});

describe('legacy dismissals in the runtime', () => {
  it('a tombstoned session id stays dismissed for both providers', async () => {
    const home = await legacyHome({ 'config.json': { dismissedSessionIds: ['gone'] } });
    const host = createRuntimeHost({
      profileRoot: home.desktop,
      hookToken: 't',
      providers: createProviderRegistry([claudeProvider, codexProvider], async () => ({
        executable: process.execPath,
        version: 'test',
      })),
    });
    await host.start();
    try {
      const { port } = host.hookServer.registration()!;
      const post = (providerId: string, body: object) =>
        fetch(`http://127.0.0.1:${port}/api/hooks/${providerId}`, {
          method: 'POST',
          headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      await post('claude', { session_id: 'gone', hook_event_name: 'SessionStart', cwd: home.root });
      await post('codex', { session_id: 'gone', event: 'SessionStart', cwd: home.root });
      await post('claude', {
        session_id: 'fresh',
        hook_event_name: 'SessionStart',
        cwd: home.root,
      });
      expect(host.snapshot().agents.map((a) => a.sessionKey.sessionId)).toEqual(['fresh']);
    } finally {
      await host.stop('test');
    }
  });
});
