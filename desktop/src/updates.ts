import type { UpdateAction, UpdateState } from '../../core/src/desktop/types.js';

/** The slice of Electrobun's `Updater` this service needs; injected so the state machine is testable. */
export interface UpdaterPort {
  /** Does this build have an update origin? Builds without one cannot update. */
  configured(): Promise<boolean>;
  check(): Promise<{ available: boolean; version?: string; error?: string }>;
  download(): Promise<{ ready: boolean; error?: string }>;
  /** Installs the downloaded update and restarts. Resolves only if the restart did not happen. */
  apply(): Promise<void>;
}

export interface UpdateServiceDeps {
  updater: UpdaterPort;
  /** Owned provider turns still running. Applying restarts the app, which would kill them. */
  busyTurns(): number;
  /** Flushes everything durable (settings, seats, window state) before the process is replaced. */
  flush(): Promise<void>;
  onChange?(state: UpdateState): void;
}

const NOT_CONFIGURED = 'Updates are not available in this build.';

/**
 * Host-owned update state machine: idle -> checking -> available -> downloading -> ready ->
 * applying, with `error` reachable from any working state. One action runs at a time; a restart
 * is refused while owned turns run and only happens after persistence is flushed.
 */
export function createUpdateService(deps: UpdateServiceDeps) {
  let state: UpdateState = { phase: 'idle', configured: false };
  let running: Promise<UpdateState> | undefined;
  let initialised: Promise<void> | undefined;

  const set = (next: Partial<UpdateState> & Pick<UpdateState, 'phase'>): UpdateState => {
    state = { configured: state.configured, ...next };
    deps.onChange?.(state);
    return state;
  };
  const init = () =>
    (initialised ??= deps.updater.configured().then(
      (configured) => {
        state = { ...state, configured };
      },
      () => undefined,
    ));

  const guard = (work: () => Promise<UpdateState>): Promise<UpdateState> => {
    if (running) return running;
    const operation = work()
      .catch((error: unknown) =>
        set({
          phase: 'error',
          version: state.version,
          message: error instanceof Error ? error.message : 'The update failed unexpectedly.',
        }),
      )
      .finally(() => {
        running = undefined;
      });
    running = operation;
    return operation;
  };

  const check = () =>
    guard(async () => {
      await init();
      if (!state.configured) return set({ phase: 'error', message: NOT_CONFIGURED });
      set({ phase: 'checking' });
      const result = await deps.updater.check();
      if (result.error) return set({ phase: 'error', message: result.error });
      return result.available
        ? set({ phase: 'available', version: result.version })
        : set({ phase: 'idle', message: 'Pixel Agents is up to date.' });
    });

  const download = () =>
    guard(async () => {
      if (state.phase !== 'available')
        return set({
          phase: state.phase,
          version: state.version,
          message: 'No update to download.',
        });
      const version = state.version;
      set({ phase: 'downloading', version });
      const result = await deps.updater.download();
      // The offered version is kept on failure so the user can retry the download.
      if (result.error || !result.ready)
        return set({
          phase: 'error',
          version,
          message: result.error ?? 'The update could not be downloaded.',
        });
      return set({ phase: 'ready', version });
    });

  const apply = () =>
    guard(async () => {
      if (state.phase !== 'ready')
        return set({ phase: state.phase, version: state.version, message: 'No update is ready.' });
      const version = state.version;
      const busy = deps.busyTurns();
      if (busy > 0)
        return set({
          phase: 'ready',
          version,
          message: `Finish or cancel ${busy} running turn${busy === 1 ? '' : 's'} before restarting to update.`,
        });
      set({ phase: 'applying', version });
      await deps.flush();
      await deps.updater.apply();
      // Reaching here means the restart did not happen; the downloaded update is still ready.
      return set({ phase: 'ready', version, message: 'The restart did not complete. Try again.' });
    });

  return {
    async state(): Promise<UpdateState> {
      await init();
      return state;
    },
    async run(action: UpdateAction): Promise<UpdateState> {
      await init();
      if (action === 'check') return check();
      if (action === 'download') return download();
      if (action === 'apply') return apply();
      throw new Error('INVALID_ARGUMENT');
    },
  };
}
