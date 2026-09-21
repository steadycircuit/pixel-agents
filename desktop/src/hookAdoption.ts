import type { ProviderId } from '../../core/src/desktop/types.js';
import type { RuntimeHost } from '../../server/src/runtimeHost.js';
import { type HooksConfigurationService, updateHooksPreference } from './hooksPreference.js';

export interface AdoptionNativeServices extends Required<HooksConfigurationService> {
  /**
   * Is what is on disk not the form the desktop wants for this provider? Claude wants the
   * standalone helper (old Node-script entries never reach the app). Codex wants the reviewed
   * node-script form with a current script (Codex only runs hooks whose exact definition the user
   * approved, so switching it to the helper silently disables the hooks).
   */
  needsUpgrade(providerId: ProviderId): Promise<boolean>;
}

export type AdoptionOutcome = 'not-installed' | 'declined' | 'upgraded' | 'recorded' | 'current';

/**
 * Brings hooks that are ALREADY on disk under the desktop app, once at startup.
 *
 * - A provider's hooks can be installed yet never reach the app (Claude's old Node-script entries; a
 *   Codex script that predates the desktop). They are brought to the desktop's form for that
 *   provider (same scope, same events: the install only swaps our own entries, so no fresh consent
 *   is needed).
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

  if (await native.needsUpgrade(providerId)) {
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
