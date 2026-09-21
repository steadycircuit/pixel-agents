import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openDesktopProfile, writeDesktopProfile } from '../src/persistence/desktopProfile.js';
import { createRuntimeHost } from '../src/runtimeHost.js';

const roots: string[] = [];
const providers = {
  refresh: async () => [],
  provider: () => undefined,
  capabilities: () => undefined,
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('desktop profile', () => {
  it('initializes an isolated versioned profile and records its migration', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pixel-desktop-profile-'));
    roots.push(root);
    const profile = await openDesktopProfile(path.join(root, 'desktop'));

    expect(profile.config.schemaVersion).toBe(1);
    expect(profile.state.seats).toEqual({});
    expect(
      JSON.parse(await readFile(path.join(root, 'desktop', 'migration.json'), 'utf8')),
    ).toMatchObject({
      schemaVersion: 1,
    });
  });

  it('persists desktop data without touching legacy source files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pixel-desktop-profile-'));
    roots.push(root);
    const desktop = path.join(root, 'desktop');
    const profile = await openDesktopProfile(desktop);
    profile.config.settings.soundEnabled = false;
    profile.state.dismissed.push('claude:session-1');
    await writeDesktopProfile(profile);

    const restored = await openDesktopProfile(desktop);
    expect(restored.config.settings.soundEnabled).toBe(false);
    expect(restored.state.dismissed).toEqual(['claude:session-1']);
  });

  it('imports standalone state, settings, dismissals, and layout without merging numeric seats', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pixel-desktop-profile-'));
    roots.push(root);
    await writeFile(
      path.join(root, 'config.json'),
      JSON.stringify({
        standalone: { soundEnabled: false, alwaysShowLabels: true },
        hooksEnabled: { claude: true, codex: false },
        dismissedSessionIds: ['dismissed-session'],
      }),
    );
    await writeFile(
      path.join(root, 'standalone-state.json'),
      JSON.stringify({
        agents: [
          {
            id: 7,
            sessionId: 'session-7',
            providerId: 'codex',
            projectDir: '/workspace',
            agentName: 'Scout',
          },
        ],
        seats: { 7: { palette: 3, seatId: 'desk-a' }, 99: { palette: 1 } },
      }),
    );
    await writeFile(path.join(root, 'layout.json'), JSON.stringify({ version: 9, areas: [] }));

    const profile = await openDesktopProfile(path.join(root, 'desktop'));
    expect(profile.config.settings).toMatchObject({ soundEnabled: false, alwaysShowLabels: true });
    expect(profile.config.settings.hooksEnabled).toEqual({ claude: true, codex: false });
    expect(profile.state.agents).toMatchObject([
      {
        agentId: 7,
        sessionKey: { providerId: 'codex', sessionId: 'session-7' },
        displayName: 'Scout',
      },
    ]);
    expect(profile.state.seats).toEqual({ 'codex:session-7': { palette: 3, seatId: 'desk-a' } });
    // The id matches no imported agent, so it stays an unqualified tombstone rather than being
    // guessed onto a provider.
    expect(profile.state.dismissed).toEqual([]);
    expect(profile.state.legacyDismissed).toEqual(['dismissed-session']);
    expect(profile.layout.layout).toEqual({ version: 9, areas: [] });
    expect(
      JSON.parse(await readFile(path.join(root, 'standalone-state.json'), 'utf8')),
    ).toMatchObject({
      agents: [{ id: 7 }],
    });
  });

  it('remembers a dismissed "Instant Detection" tip across restarts, and never brings it back', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pixel-desktop-profile-'));
    roots.push(root);
    const desktop = path.join(root, 'desktop');
    const first = createRuntimeHost({ profileRoot: desktop, providers });
    expect((await first.start()).settings.hooksInfoShown).toBe(false);
    expect((await first.setSetting('hooksInfoShown', true)).hooksInfoShown).toBe(true);
    await first.stop('test');

    const second = createRuntimeHost({ profileRoot: desktop, providers });
    expect((await second.start()).settings.hooksInfoShown).toBe(true);
    await second.stop('test');
    expect(
      JSON.parse(await readFile(path.join(desktop, 'config.json'), 'utf8')).settings,
    ).toMatchObject({
      hooksInfoShown: true,
    });
  });

  it('gives an existing profile without the setting the default, and carries the legacy answer over', async () => {
    const legacy = await mkdtemp(path.join(os.tmpdir(), 'pixel-desktop-profile-'));
    roots.push(legacy);
    await writeFile(
      path.join(legacy, 'config.json'),
      JSON.stringify({ standalone: { hooksInfoShown: true } }),
    );
    expect(
      (await openDesktopProfile(path.join(legacy, 'desktop'))).config.settings.hooksInfoShown,
    ).toBe(true);

    const old = await mkdtemp(path.join(os.tmpdir(), 'pixel-desktop-profile-'));
    roots.push(old);
    const desktop = path.join(old, 'desktop');
    const created = await openDesktopProfile(desktop);
    const { hooksInfoShown: _drop, ...withoutIt } = created.config.settings;
    created.config.settings = withoutIt as typeof created.config.settings;
    await writeDesktopProfile(created);
    expect((await openDesktopProfile(desktop)).config.settings.hooksInfoShown).toBe(false);
  });

  it('serializes revisioned layout and setting writes through the runtime host', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pixel-desktop-profile-'));
    roots.push(root);
    const host = createRuntimeHost({ profileRoot: path.join(root, 'desktop'), providers });
    const initial = await host.start();
    const revision = await host.saveLayout({ version: 1, cols: 1 }, initial.layoutRevision);
    expect(revision).toBe(1);
    await expect(host.saveLayout({}, initial.layoutRevision)).rejects.toThrow('CONFLICT');
    const settings = await host.setSetting('soundEnabled', false);
    expect(settings.soundEnabled).toBe(false);
    const workspace = await host.addWorkspace(root);
    expect(workspace.path).toBe(root);
    await host.removeWorkspace(workspace.id);
    expect(host.snapshot().settings.workspaces).toEqual([]);
    await host.stop('test');
  });
});
