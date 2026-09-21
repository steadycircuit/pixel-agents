import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

// The desktop must never consult the legacy shared config.json: any call is a failure.
vi.mock('../src/configPersistence.js', () => {
  const forbidden = () => {
    throw new Error('legacy config.json was used by the desktop consent path');
  };
  return {
    getHooksConsent: forbidden,
    recordHooksDecline: forbidden,
    clearHooksConsent: forbidden,
    clearHooksAnswer: forbidden,
    readConfig: forbidden,
    writeConfig: forbidden,
  };
});

import { createConsentService } from '../../desktop/src/consentService.js';
import { updateHooksPreference } from '../../desktop/src/hooksPreference.js';
import { createProviderRegistry } from '../src/providerRegistry.js';
import { claudeProvider, codexProvider } from '../src/providers/index.js';
import { createRuntimeHost } from '../src/runtimeHost.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(options: { alreadyInstalled?: boolean; failInstall?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pixel-consent-'));
  roots.push(root);
  const disk = { claude: options.alreadyInstalled === true, codex: false };
  const calls: string[] = [];
  const host = createRuntimeHost({
    profileRoot: path.join(root, 'desktop'),
    hookToken: 't',
    hooksInstalled: async (providerId) => disk[providerId],
    providers: createProviderRegistry([claudeProvider, codexProvider], async () => ({
      executable: process.execPath,
      version: 'test',
    })),
  });
  await host.start();
  const native = {
    async setHooksEnabled(providerId: 'claude' | 'codex', enabled: boolean) {
      calls.push(`${enabled ? 'install' : 'uninstall'}:${providerId}`);
      if (enabled && options.failInstall) throw new Error('settings.json is read-only');
      disk[providerId] = enabled;
    },
    async areHooksInstalled(providerId: 'claude' | 'codex') {
      return disk[providerId];
    },
    async uninstallHooks(providerId: 'claude' | 'codex') {
      calls.push(`uninstall:${providerId}`);
      disk[providerId] = false;
    },
  };
  const service = createConsentService(host, native);
  const state = (providerId: 'claude' | 'codex' = 'claude') => ({
    hooks: host.snapshot().hooks[providerId],
    enabled: host.snapshot().settings.hooksEnabled[providerId],
    asked: host.snapshot().consentRequests.some((r) => r.providerId === providerId),
  });
  return { host, service, native, disk, calls, state, stop: () => host.stop('test') };
}

describe('desktop first-run consent', () => {
  it('asks each provider with nothing of ours installed, using the provider disclosure', async () => {
    const t = await setup();
    try {
      const requests = t.host.snapshot().consentRequests;
      expect(requests.map((r) => r.providerId)).toEqual(['claude', 'codex']);
      expect(requests[0]!.disclosure.length).toBeGreaterThan(20);
      expect(t.state().hooks).toEqual({ installed: false, consent: 'unanswered' });
    } finally {
      await t.stop();
    }
  });

  it('does not ask a provider whose hooks are already installed', async () => {
    const t = await setup({ alreadyInstalled: true });
    try {
      expect(t.state('claude').asked).toBe(false);
      expect(t.state('codex').asked).toBe(true);
    } finally {
      await t.stop();
    }
  });

  it('Install grants consent, installs, verifies, and retires the ask', async () => {
    const t = await setup();
    try {
      await t.service.answer('claude', 'install');
      expect(t.calls).toEqual(['install:claude']);
      expect(t.state()).toMatchObject({
        hooks: { installed: true, consent: 'granted' },
        enabled: true,
        asked: false,
      });
      expect(t.state('codex').asked).toBe(true); // other providers are untouched
    } finally {
      await t.stop();
    }
  });

  it('Never, with nothing installed, records the decline and hooks-off without touching the file', async () => {
    const t = await setup();
    try {
      await t.service.answer('claude', 'never');
      expect(t.calls).toEqual([]);
      expect(t.state()).toMatchObject({
        hooks: { installed: false, consent: 'declined' },
        enabled: false,
        asked: false,
      });
    } finally {
      await t.stop();
    }
  });

  it('Not Now writes nothing and the ask returns', async () => {
    const t = await setup();
    try {
      await t.service.answer('claude', 'notNow');
      expect(t.calls).toEqual([]);
      expect(t.state()).toMatchObject({ hooks: { consent: 'unanswered' }, asked: true });
    } finally {
      await t.stop();
    }
  });

  it('a revised Not Now undoes an Install completely', async () => {
    const t = await setup();
    try {
      await t.service.answer('claude', 'install');
      await t.service.answer('claude', 'notNow');
      expect(t.calls).toEqual(['install:claude', 'uninstall:claude']);
      expect(t.state()).toMatchObject({
        hooks: { installed: false, consent: 'unanswered' },
        asked: true,
      });
    } finally {
      await t.stop();
    }
  });

  it('a revised Never over an Install removes the hooks and records the decline', async () => {
    const t = await setup();
    try {
      await t.service.answer('claude', 'install');
      await t.service.answer('claude', 'never');
      expect(t.state()).toMatchObject({
        hooks: { installed: false, consent: 'declined' },
        enabled: false,
      });
    } finally {
      await t.stop();
    }
  });

  it('a revised Not Now over a decline takes the decline (and its hooks-off) back', async () => {
    const t = await setup();
    try {
      await t.service.answer('claude', 'never');
      await t.service.answer('claude', 'notNow');
      expect(t.state()).toMatchObject({
        hooks: { consent: 'unanswered' },
        enabled: false,
        asked: true,
      });
    } finally {
      await t.stop();
    }
  });

  it('a failed install leaves the grant recorded but the preference off, and Not Now can undo it', async () => {
    const t = await setup({ failInstall: true });
    try {
      await t.service.answer('claude', 'install');
      expect(t.state()).toMatchObject({
        hooks: { installed: false, consent: 'granted' },
        enabled: false,
      });
      await t.service.answer('claude', 'notNow');
      expect(t.state()).toMatchObject({ hooks: { consent: 'unanswered' }, asked: true });
    } finally {
      await t.stop();
    }
  });

  it('applies rapid revisions in order (walk Back and re-answer)', async () => {
    const t = await setup();
    try {
      await Promise.all([
        t.service.answer('claude', 'install'),
        t.service.answer('claude', 'notNow'),
        t.service.answer('claude', 'install'),
      ]);
      expect(t.state()).toMatchObject({
        hooks: { installed: true, consent: 'granted' },
        enabled: true,
      });
    } finally {
      await t.stop();
    }
  });

  it('rejects invalid providers and choices without acting', async () => {
    const t = await setup();
    try {
      await expect(t.service.answer('gemini', 'install')).rejects.toThrow('INVALID_ARGUMENT');
      await expect(t.service.answer('claude', 'yes-please')).rejects.toThrow('INVALID_ARGUMENT');
      expect(t.calls).toEqual([]);
    } finally {
      await t.stop();
    }
  });
});

describe('Settings toggle and consent', () => {
  it('turning hooks on is itself the grant; a failed install leaves the preference off', async () => {
    const t = await setup({ failInstall: true });
    try {
      const result = await updateHooksPreference(t.host, t.native, {
        providerId: 'codex',
        enabled: true,
        epoch: t.host.snapshot().epoch,
      });
      expect(result.ok).toBe(false);
      expect(t.state('codex')).toMatchObject({ hooks: { consent: 'granted' }, enabled: false });
    } finally {
      await t.stop();
    }
  });

  it('refuses to persist the preference when the file does not agree afterwards', async () => {
    const t = await setup();
    try {
      const lying = { ...t.native, areHooksInstalled: async () => false };
      const result = await updateHooksPreference(t.host, lying, {
        providerId: 'claude',
        enabled: true,
        epoch: t.host.snapshot().epoch,
      });
      expect(result).toMatchObject({ ok: false, error: { code: 'IO_ERROR' } });
      expect(t.state().enabled).toBe(false);
    } finally {
      await t.stop();
    }
  });
});
