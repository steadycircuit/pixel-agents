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

type Kind = 'none' | 'legacy' | 'desktop';
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
      disk[providerId] = enabled ? 'desktop' : 'none';
    },
    areHooksInstalled: async (providerId: 'claude' | 'codex') => disk[providerId] !== 'none',
    hasLegacyHooks: async (providerId: 'claude' | 'codex') => disk[providerId] === 'legacy',
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
  it('upgrades old Node-script entries to the desktop helper, so that provider reaches the app', async () => {
    const t = await setup({ claude: 'desktop', codex: 'legacy' });
    try {
      const outcome = await adoptExistingHooks(t.host, t.native);
      expect(outcome.codex).toBe('upgraded');
      expect(t.calls).toEqual(['install:codex']);
      expect(t.view('codex')).toEqual({
        disk: 'desktop',
        consent: 'granted',
        enabled: true,
        asked: false,
      });
    } finally {
      await t.stop();
    }
  });

  it('records consent silently for our own current entries, without touching the provider file', async () => {
    const t = await setup({ claude: 'desktop', codex: 'none' });
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
    const t = await setup({ claude: 'desktop', codex: 'legacy' });
    try {
      await t.host.consent.recordDecline('codex');
      const outcome = await adoptExistingHooks(t.host, t.native);
      expect(outcome.codex).toBe('declined');
      expect(t.calls).toEqual([]);
      expect(t.view('codex')).toMatchObject({
        disk: 'legacy',
        consent: 'declined',
        enabled: false,
      });
    } finally {
      await t.stop();
    }
  });

  it('is idempotent: a second pass changes nothing', async () => {
    const t = await setup({ claude: 'legacy', codex: 'legacy' });
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
    const t = await setup({ claude: 'desktop', codex: 'legacy' }, { failInstall: true });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const outcome = await adoptExistingHooks(t.host, t.native);
      expect(outcome.codex).toBe('current');
      expect(outcome.claude).toBe('recorded');
      expect(t.view('codex')).toMatchObject({ disk: 'legacy', enabled: false });
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
      await t.stop();
    }
  });
});
