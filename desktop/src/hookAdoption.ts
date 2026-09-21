import type { ProviderId } from '../../core/src/desktop/types.js';

import type { RuntimeHost } from '../../server/src/runtimeHost.js';
import { type HooksConfigurationService, updateHooksPreference } from './hooksPreference.js';

export interface AdoptionNativeServices extends Required<HooksConfigurationService> {
  /** Are any of our entries the pre-desktop Node-script form, which never reaches the desktop app? */
  hasLegacyHooks(providerId: ProviderId): Promise<boolean>;
}

export type AdoptionOutcome = 'not-installed' | 'declined' | 'upgraded' | 'recorded' | 'current';

/**
 * Brings hooks that are ALREADY on disk under the desktop app, once at startup.
 *
 * - Old Node-script entries do not forward to the desktop app, so a provider that "has hooks" can
 *   still never show up. They are replaced with the desktop helper (same scope, same events: the
 *   install only swaps our own entries, so no fresh consent is needed).
 * - Our entries with no recorded answer are granted silently, as the first-run consent policy says:
 *   the only population asked is the one with nothing installed.
 * - An explicit decline is respected, and a provider with nothing installed is left to the
 *   first-run ask.
 */
export async function adoptExistingHooks(
  host: Pick<RuntimeHost, 'snapshot' | 'setHooksEnabled' | 'consent' | 'refreshHooks'>,
  native: AdoptionNativeServices,
): Promise<Record<ProviderId, AdoptionOutcome>> {
  const outcome = {} as Record<ProviderId, AdoptionOutcome>;
  for (const providerId of ['claude', 'codex'] as const) {
    try {
      outcome[providerId] = await adoptOne(host, native, providerId);
    } catch (error) {
      // Never block startup: a provider we cannot read simply stays as it was.
      console.error(`[Desktop] Could not adopt existing ${providerId} hooks:`, error);
      outcome[providerId] = 'current';
    }
  }
  return outcome;
}

async function adoptOne(
  host: Pick<RuntimeHost, 'snapshot' | 'setHooksEnabled' | 'consent' | 'refreshHooks'>,
  native: AdoptionNativeServices,
  providerId: ProviderId,
): Promise<AdoptionOutcome> {
  if (!(await native.areHooksInstalled(providerId).catch(() => false))) return 'not-installed';
  const consent = host.consent.get(providerId);
  if (consent === 'declined') return 'declined';

  if (await native.hasLegacyHooks(providerId)) {
    const result = await updateHooksPreference(host, native, {
      providerId,
      enabled: true,
      epoch: host.snapshot().epoch,
    });
    if (!result.ok) throw new Error(result.error.message);
    return 'upgraded';
  }
  const enabled = host.snapshot().settings.hooksEnabled[providerId];
  if (consent === 'granted' && enabled) return 'current';
  if (consent !== 'granted') await host.consent.grant(providerId);
  if (!enabled) await host.setHooksEnabled(providerId, true);
  await host.refreshHooks();
  return 'recorded';
}
