import type { ConsentChoice, ProviderId } from '../../core/src/desktop/types.js';
import { isProviderId } from '../../core/src/desktop/validation.js';
import {
  applyConsentChoice,
  type ConsentEffects,
} from '../../server/src/providers/hook/consentExecutor.js';
import type { RuntimeHost } from '../../server/src/runtimeHost.js';
import { type HooksConfigurationService, updateHooksPreference } from './hooksPreference.js';

const CHOICES = new Set<ConsentChoice>(['install', 'notNow', 'never']);

/**
 * Carries out an Intro consent answer for the desktop app. The policy (what an answer means) and
 * the ORDER of writes are the shared ones in `consentExecutor`; this supplies only the desktop
 * effects and the desktop profile as the consent repository, so the legacy `config.json` is never
 * read or written.
 */
export function createConsentService(
  host: Pick<RuntimeHost, 'snapshot' | 'setHooksEnabled' | 'consent' | 'refreshHooks'>,
  native: Required<HooksConfigurationService> & {
    uninstallHooks(providerId: ProviderId): Promise<void>;
  },
) {
  const effectsFor = (providerId: ProviderId): ConsentEffects => ({
    async setHooksEnabled(enabled) {
      // The same route as the Settings toggle. Every effect resolves; a failure is logged, and the
      // install state re-derived below tells the user what really happened.
      const result = await updateHooksPreference(host, native, {
        providerId,
        enabled,
        epoch: host.snapshot().epoch,
      });
      if (!result.ok) console.error(`[Desktop] Hooks change failed: ${result.error.message}`);
    },
    async uninstallHooks() {
      await native.uninstallHooks(providerId).catch((error: unknown) => {
        console.error('[Desktop] Hook uninstall failed:', error);
      });
    },
    areHooksInstalled: () => native.areHooksInstalled(providerId),
    // The desktop keeps no separate live "hooks off" mirror; the profile write is the whole effect.
    syncHooksPreferenceOff: () => undefined,
    reportHooksStatus: () => host.refreshHooks(),
  });

  return {
    /** Serialized across providers (one queue in the executor). Rejects only on invalid input. */
    async answer(providerId: unknown, choice: unknown): Promise<void> {
      if (!isProviderId(providerId) || !CHOICES.has(choice as ConsentChoice))
        throw new Error('INVALID_ARGUMENT');
      await applyConsentChoice(providerId, choice, effectsFor(providerId), host.consent);
      await host.refreshHooks();
    },
  };
}
