import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { adoptExistingHooks } from '../../desktop/src/hookAdoption.js';
import { createProviderRegistry } from '../src/providerRegistry.js';
import { claudeProvider, codexProvider } from '../src/providers/index.js';
import { createRuntimeHost } from '../src/runtimeHost.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * What is on disk. Claude wants the standalone 'helper'; Codex wants the reviewed node 'script'
 * (Codex only runs hooks whose exact definition the user approved, so the helper would silently
 * disable them). 'script' is therefore "old" for Claude and "current" for Codex.
 */
type Kind = 'none' | 'script' | 'helper';
const WANTED: Record<'claude' | 'codex', Kind> = { claude: 'helper', codex: 'script' };
async function setup(disk: { claude: Kind; codex: Kind }, options: { failInstall?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pixel-adopt-'));
  roots.push(root);
  const calls: string[] = [];
  const host = createRuntimeHost({
    profileRoot: path.join(root, 'desktop'),
    hookToken: 't',
    hooksInstalled: async (providerId) => disk[providerId] !== 'none',
    providers: createProviderRegistry([claudeProvider, codexProvider], async () => ({
      executable: process.execPath,
      version: 'test',
    })),
  });
  await host.start();
  const native = {
    async setHooksEnabled(providerId: 'claude' | 'codex', enabled: boolean) {
      calls.push(`${enabled ? 'install' : 'uninstall'}:${providerId}`);
      if (enabled && options.failInstall) throw new Error('hooks.json is read-only');
      disk[providerId] = enabled ? WANTED[providerId] : 'none';
    },
    areHooksInstalled: async (providerId: 'claude' | 'codex') => disk[providerId] !== 'none',
    needsUpgrade: async (providerId: 'claude' | 'codex') =>
      disk[providerId] !== 'none' && disk[providerId] !== WANTED[providerId],
  };
  const view = (providerId: 'claude' | 'codex') => ({
    disk: disk[providerId],
    consent: host.snapshot().hooks[providerId].consent,
    enabled: host.snapshot().settings.hooksEnabled[providerId],
    asked: host.snapshot().consentRequests.some((r) => r.providerId === providerId),
  });
  return { host, native, disk, calls, view, stop: () => host.stop('test') };
}

describe('adopting hooks that are already installed', () => {
  it('upgrades Claude entries that never reach the desktop app to the standalone helper', async () => {
    const t = await setup({ claude: 'script', codex: 'script' });
    try {
      const outcome = await adoptExistingHooks(t.host, t.native);
      expect(outcome.claude).toBe('upgraded');
      expect(t.view('claude')).toEqual({
        disk: 'helper',
        consent: 'granted',
        enabled: true,
        asked: false,
      });
    } finally {
      await t.stop();
    }
  });

  it('moves Codex BACK to the reviewed script form: the helper form would never be approved', async () => {
    const t = await setup({ claude: 'helper', codex: 'helper' });
    try {
      const outcome = await adoptExistingHooks(t.host, t.native);
      expect(outcome.codex).toBe('upgraded');
      expect(t.calls).toEqual(['install:codex']);
      expect(t.view('codex')).toEqual({
        disk: 'script',
        consent: 'granted',
        enabled: true,
        asked: false,
      });
    } finally {
      await t.stop();
    }
  });

  it('records consent silently for our own current entries, without touching the provider file', async () => {
    const t = await setup({ claude: 'helper', codex: 'none' });
    try {
      const outcome = await adoptExistingHooks(t.host, t.native);
      expect(outcome.claude).toBe('recorded');
      expect(t.calls).toEqual([]);
      expect(t.view('claude')).toMatchObject({ consent: 'granted', enabled: true });
    } finally {
      await t.stop();
    }
  });

  it('leaves a provider with nothing installed to the first-run ask', async () => {
    const t = await setup({ claude: 'none', codex: 'none' });
    try {
      const outcome = await adoptExistingHooks(t.host, t.native);
      expect(outcome).toEqual({ claude: 'not-installed', codex: 'not-installed' });
      expect(t.calls).toEqual([]);
      expect(t.view('codex')).toMatchObject({ consent: 'unanswered', asked: true });
    } finally {
      await t.stop();
    }
  });

  it('respects an explicit decline even when entries remain on disk', async () => {
    const t = await setup({ claude: 'helper', codex: 'helper' });
    try {
      await t.host.consent.recordDecline('codex');
      const outcome = await adoptExistingHooks(t.host, t.native);
      expect(outcome.codex).toBe('declined');
      expect(t.calls).toEqual([]);
      expect(t.view('codex')).toMatchObject({
        disk: 'helper',
        consent: 'declined',
        enabled: false,
      });
    } finally {
      await t.stop();
    }
  });

  it('is idempotent: a second pass changes nothing', async () => {
    const t = await setup({ claude: 'script', codex: 'helper' });
    try {
      await adoptExistingHooks(t.host, t.native);
      t.calls.length = 0;
      const again = await adoptExistingHooks(t.host, t.native);
      expect(again).toEqual({ claude: 'current', codex: 'current' });
      expect(t.calls).toEqual([]);
    } finally {
      await t.stop();
    }
  });

  it('a failed upgrade is logged and leaves the entries and the other provider alone', async () => {
    const t = await setup({ claude: 'helper', codex: 'helper' }, { failInstall: true });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const outcome = await adoptExistingHooks(t.host, t.native);
      expect(outcome.codex).toBe('current');
      expect(outcome.claude).toBe('recorded');
      expect(t.view('codex')).toMatchObject({ disk: 'helper', enabled: false });
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
      await t.stop();
    }
  });
});
