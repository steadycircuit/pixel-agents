import { describe, expect, it, vi } from 'vitest';

import type { DesktopSettings } from '../../core/src/desktop/types.js';
import type { HookProvider } from '../../core/src/provider.js';
import { createProviderRegistry, probeProviderExecutable } from '../src/providerRegistry.js';

const settings: DesktopSettings = {
  soundEnabled: true,
  alwaysShowLabels: false,
  ghostHeadlessAgents: false,
  watchAllSessions: false,
  showAreas: false,
  hooksInfoShown: false,
  workspaces: [],
  providerExecutables: {},
  hooksEnabled: { claude: false, codex: false },
};

function provider(id: 'claude' | 'codex', teams = false): HookProvider {
  return {
    kind: 'hook',
    id,
    displayName: id,
    installCommand: id,
    docsUrl: 'https://example.test',
    protocolVersion: 1,
    normalizeHookEvent: () => null,
    installHooks: async () => undefined,
    uninstallHooks: async () => undefined,
    areHooksInstalled: async () => false,
    consentDisclosure: () => ({ headline: '', disclosure: '' }),
    formatToolStatus: () => '',
    permissionExemptTools: new Set(),
    subagentToolNames: new Set(),
    readingTools: new Set(),
    buildLaunchCommand: () => ({ command: id, args: [] }),
    buildPromptCommand: () => ({ command: id, args: [] }),
    team: teams ? ({} as HookProvider['team']) : undefined,
  };
}

describe('desktop provider registry', () => {
  it('probes both providers concurrently and reports their independent capabilities', async () => {
    const probe = vi.fn(async (providerId: 'claude' | 'codex') => ({
      executable: `/tools/${providerId}`,
      version: `${providerId} 1.0`,
    }));
    const registry = createProviderRegistry([provider('claude', true), provider('codex')], probe);
    const result = await registry.refresh(settings);
    expect(result).toEqual([
      expect.objectContaining({ providerId: 'claude', available: true, supportsTeams: true }),
      expect.objectContaining({ providerId: 'codex', available: true, supportsTeams: false }),
    ]);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('keeps one missing provider from degrading the other', async () => {
    const registry = createProviderRegistry(
      [provider('claude'), provider('codex')],
      async (providerId) => {
        if (providerId === 'claude') throw new Error('not installed');
        return { executable: '/tools/codex', version: 'codex 1.0' };
      },
    );
    const result = await registry.refresh(settings);
    expect(result[0]).toMatchObject({
      providerId: 'claude',
      available: false,
      error: 'not installed',
    });
    expect(result[1]).toMatchObject({ providerId: 'codex', available: true });
  });

  it('accepts a configured absolute executable and rejects relative overrides', async () => {
    await expect(probeProviderExecutable('codex', process.execPath)).resolves.toMatchObject({
      executable: process.execPath,
    });
    await expect(probeProviderExecutable('codex', './codex')).rejects.toThrow('must be absolute');
  });
});
