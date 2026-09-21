import type { DesktopSettings, RpcResult } from '../../core/src/desktop/types.js';
import { isProviderId } from '../../core/src/desktop/validation.js';
import type { RuntimeHost } from '../../server/src/runtimeHost.js';
import { fail, ok } from './rpcResult.js';

export interface HooksConfigurationService {
  /** Installs (true) or removes (false) our hook entries in the provider's settings file. */
  setHooksEnabled(providerId: 'claude' | 'codex', enabled: boolean): Promise<void>;
  /** Reads the provider's settings file. Used to confirm a change actually landed. */
  areHooksInstalled?(providerId: 'claude' | 'codex'): Promise<boolean>;
}

/**
 * The Settings-toggle path, and the path an Intro "Install" answer takes. Order matters:
 *   1. enabling records the consent grant BEFORE the provider file is touched (the install itself
 *      is the act consent covers; a failure leaves the grant, which a revised answer can revert),
 *   2. the provider's settings file changes,
 *   3. the on-disk result is re-read and must agree,
 *   4. only then is the preference persisted — a failed write never records `hooksEnabled: true`
 *      over an untouched provider config, and a failed uninstall never records `false` over live
 *      entries.
 */
export async function updateHooksPreference(
  host: Pick<RuntimeHost, 'snapshot' | 'setHooksEnabled' | 'consent'>,
  native: HooksConfigurationService,
  request: { providerId: unknown; enabled: unknown; epoch: string },
): Promise<RpcResult<DesktopSettings>> {
  if (request.epoch !== host.snapshot().epoch)
    return fail('STALE_CLIENT', 'Desktop state changed; refresh and try again');
  const { providerId, enabled } = request;
  if (!isProviderId(providerId) || typeof enabled !== 'boolean')
    return fail('INVALID_ARGUMENT', 'Invalid hook preference');
  try {
    if (enabled) await host.consent.grant(providerId);
    await native.setHooksEnabled(providerId, enabled);
    if (native.areHooksInstalled && (await native.areHooksInstalled(providerId)) !== enabled)
      throw new Error(
        enabled
          ? 'Hooks were not found in the provider settings after installing'
          : 'Hook entries are still present in the provider settings',
      );
    return ok(await host.setHooksEnabled(providerId, enabled));
  } catch (error) {
    return fail(
      'IO_ERROR',
      error instanceof Error ? error.message : 'Unable to update hooks',
      true,
    );
  }
}
