import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { updateHooksPreference } from '../../desktop/src/hooksPreference.js';
import { createProviderRegistry } from '../src/providerRegistry.js';
import { claudeProvider, codexProvider } from '../src/providers/index.js';
import { createRuntimeHost } from '../src/runtimeHost.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await chmod(path.join(root, 'desktop'), 0o700).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }),
  );
});

async function startHost() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pixel-hooks-pref-'));
  roots.push(root);
  const host = createRuntimeHost({
    profileRoot: path.join(root, 'desktop'),
    hookToken: 'hook-token',
    providers: createProviderRegistry([claudeProvider, codexProvider], async (providerId) => ({
      executable: process.execPath,
      version: `${providerId} test`,
    })),
  });
  await host.start();
  return { root, host, configPath: path.join(root, 'desktop', 'config.json') };
}

const persistedHooks = async (configPath: string) =>
  JSON.parse(await readFile(configPath, 'utf8')).settings.hooksEnabled;

describe('updateHooksPreference ordering', () => {
  it('does not persist hooksEnabled when the provider config write fails', async () => {
    const { host, configPath } = await startHost();
    try {
      const native = {
        setHooksEnabled: vi.fn().mockRejectedValue(new Error('settings.json busy')),
      };
      const result = await updateHooksPreference(host, native, {
        providerId: 'claude',
        enabled: true,
        epoch: host.snapshot().epoch,
      });
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'IO_ERROR', message: 'settings.json busy', retryable: true },
      });
      expect(native.setHooksEnabled).toHaveBeenCalledWith('claude', true);
      expect(host.snapshot().settings.hooksEnabled.claude).toBe(false);
      expect((await persistedHooks(configPath)).claude).toBe(false);
    } finally {
      await host.stop('test');
    }
  });

  it('persists the preference only after the native change succeeded', async () => {
    const { host, configPath } = await startHost();
    try {
      const order: string[] = [];
      const native = {
        setHooksEnabled: vi.fn(async () => {
          order.push('native');
          expect(host.snapshot().settings.hooksEnabled.codex).toBe(false);
        }),
      };
      const result = await updateHooksPreference(host, native, {
        providerId: 'codex',
        enabled: true,
        epoch: host.snapshot().epoch,
      });
      expect(order).toEqual(['native']);
      expect(result.ok && result.value.hooksEnabled).toEqual({ claude: false, codex: true });
      expect((await persistedHooks(configPath)).codex).toBe(true);
    } finally {
      await host.stop('test');
    }
  });

  it('keeps hooksEnabled true when an uninstall fails', async () => {
    const { host, configPath } = await startHost();
    try {
      const epoch = host.snapshot().epoch;
      const enable = { setHooksEnabled: vi.fn().mockResolvedValue(undefined) };
      await updateHooksPreference(host, enable, { providerId: 'claude', enabled: true, epoch });
      const disable = { setHooksEnabled: vi.fn().mockRejectedValue(new Error('uninstall failed')) };
      const result = await updateHooksPreference(host, disable, {
        providerId: 'claude',
        enabled: false,
        epoch,
      });
      expect(result.ok).toBe(false);
      expect(host.snapshot().settings.hooksEnabled.claude).toBe(true);
      expect((await persistedHooks(configPath)).claude).toBe(true);
    } finally {
      await host.stop('test');
    }
  });

  it('rejects stale epochs and malformed requests before touching provider config', async () => {
    const { host } = await startHost();
    try {
      const native = { setHooksEnabled: vi.fn() };
      const epoch = host.snapshot().epoch;
      expect(
        await updateHooksPreference(host, native, {
          providerId: 'claude',
          enabled: true,
          epoch: 'old',
        }),
      ).toMatchObject({ ok: false, error: { code: 'STALE_CLIENT' } });
      expect(
        await updateHooksPreference(host, native, { providerId: 'gemini', enabled: true, epoch }),
      ).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
      expect(
        await updateHooksPreference(host, native, { providerId: 'claude', enabled: 'yes', epoch }),
      ).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
      expect(native.setHooksEnabled).not.toHaveBeenCalled();
    } finally {
      await host.stop('test');
    }
  });

  it.skipIf(process.getuid?.() === 0)(
    'does not leave hooksEnabled set in memory when the host write fails',
    async () => {
      const { root, host, configPath } = await startHost();
      try {
        await chmod(path.join(root, 'desktop'), 0o500);
        const native = { setHooksEnabled: vi.fn().mockResolvedValue(undefined) };
        const result = await updateHooksPreference(host, native, {
          providerId: 'claude',
          enabled: true,
          epoch: host.snapshot().epoch,
        });
        expect(result.ok).toBe(false);
        expect(host.snapshot().settings.hooksEnabled.claude).toBe(false);
        await chmod(path.join(root, 'desktop'), 0o700);
        expect((await persistedHooks(configPath)).claude).toBe(false);
      } finally {
        await chmod(path.join(root, 'desktop'), 0o700).catch(() => undefined);
        await host.stop('test');
      }
    },
  );
});
