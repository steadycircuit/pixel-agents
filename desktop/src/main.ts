import { randomBytes, randomUUID } from 'node:crypto';
import * as path from 'node:path';

import Electrobun, {
  app,
  BrowserWindow,
  BuildConfig,
  Screen,
  Updater,
  Utils,
} from 'electrobun/main';

import {
  areHooksInstalled as areClaudeHooksInstalled,
  hasLegacyHookCommands as hasLegacyClaudeHooks,
  uninstallHooks as uninstallClaudeHooks,
} from '../../server/src/providers/hook/claude/claudeHookInstaller.js';
import {
  areHooksInstalled as areCodexHooksInstalled,
  hasLegacyHookCommands as hasLegacyCodexHooks,
  uninstallHooks as uninstallCodexHooks,
} from '../../server/src/providers/hook/codex/codexHookInstaller.js';
import { installDesktopHelper } from '../../server/src/providers/hook/desktopHelperInstaller.js';
import { createRuntimeHost } from '../../server/src/runtimeHost.js';
import { APP_VERSION } from '../generated/buildInfo.js';
import { createConsentService } from './consentService.js';
import { adoptExistingHooks } from './hookAdoption.js';
import { EventBridge } from './eventBridge.js';
import { captureConsole, createLogger } from './logging.js';
import { desktopRoot, logRoot, resourceRoot } from './paths.js';
import { createDesktopRPC } from './rpcHandlers.js';
import { createSingleInstanceLock } from './singleInstance.js';
import { createUpdateService } from './updates.js';
import {
  createWindowStateSaver,
  initialFrame,
  loadWindowState,
  saveWindowState,
  type WindowState,
} from './windowState.js';

/** Native SDK integration is deliberately kept at this boundary. The runtime
 * host can be tested without opening a window and is also used by smoke tests. */
export async function startDesktop(): Promise<void> {
  const instanceId = randomUUID();
  const logger = createLogger({
    dir: logRoot(),
    context: {
      appVersion: APP_VERSION,
      runtime: 'cottontail',
      platform: process.platform,
      instanceId,
    },
  });
  captureConsole(logger);
  console.log('[Desktop] Starting');
  const hookToken = randomBytes(32).toString('base64url');
  const instanceLock = createSingleInstanceLock({
    profileRoot: desktopRoot(),
    instanceId,
    token: hookToken,
  });
  const ownership = await instanceLock.acquire();
  if (!ownership.primary) {
    app.quit();
    return;
  }
  let window: BrowserWindow | undefined;
  const host = createRuntimeHost({
    appVersion: APP_VERSION,
    profileRoot: desktopRoot(),
    assetRoot: resourceRoot(),
    hooksInstalled: async (providerId) =>
      providerId === 'claude' ? areClaudeHooksInstalled() : areCodexHooksInstalled(),
    hookToken,
    instanceId,
    onFocusRequested: () => {
      window?.show();
      window?.activate();
    },
  });
  let snapshot;
  try {
    snapshot = await host.start();
  } catch (error) {
    await instanceLock.release();
    throw error;
  }
  const build = BuildConfig.getSync();
  if (!build.availableRenderers.includes('cef')) {
    await host.stop('CEF renderer unavailable');
    throw new Error('Pixel Agents requires the bundled CEF renderer');
  }
  const bridge = new EventBridge(host.snapshot);
  let rpc: ReturnType<typeof createDesktopRPC>;
  const nativeServices = {
    async selectWorkspaceFolder() {
      const [folder] = await Utils.openFileDialog({
        canChooseFiles: false,
        canChooseDirectory: true,
        allowsMultipleSelection: false,
      });
      return folder;
    },
    async setHooksEnabled(providerId: 'claude' | 'codex', enabled: boolean) {
      if (!enabled) {
        if (providerId === 'claude') await uninstallClaudeHooks();
        else await uninstallCodexHooks();
        return;
      }
      const suffix = process.platform === 'win32' ? '.exe' : '';
      await installDesktopHelper({
        providerId,
        source: path.join(resourceRoot(), 'hooks', `pixel-agents-hook${suffix}`),
        helperVersion: APP_VERSION,
      });
    },
    async areHooksInstalled(providerId: 'claude' | 'codex') {
      return providerId === 'claude' ? areClaudeHooksInstalled() : areCodexHooksInstalled();
    },
  };
  const consent = createConsentService(host, {
    ...nativeServices,
    uninstallHooks: (providerId) => nativeServices.setHooksEnabled(providerId, false),
  });
  const updates = createUpdateService({
    updater: {
      // No update origin is configured until release inputs are resolved; without one the UI says so.
      configured: async () => Boolean(await Updater.localInfo.baseUrl().catch(() => '')),
      async check() {
        const info = await Updater.checkForUpdate();
        return {
          available: info.updateAvailable,
          version: info.version,
          error: info.error || undefined,
        };
      },
      async download() {
        await Updater.downloadUpdate();
        const info = Updater.updateInfo();
        return { ready: info.updateReady, error: info.error || undefined };
      },
      apply: () => Updater.applyUpdate(),
    },
    busyTurns: () =>
      host.processes.list().filter((operation) => operation.finishedAt === undefined).length,
    flush: async () => {
      await windowSaver.flush();
    },
    onChange: (state) => bridge.publish({ type: 'updateStateChanged', state }),
  });
  // Hooks already on disk (including old Node-script entries that never reach this app) are
  // brought under the desktop helper once, in the background; failures are logged, never fatal.
  void adoptExistingHooks(host, {
    ...nativeServices,
    hasLegacyHooks: async (providerId) =>
      providerId === 'claude' ? hasLegacyClaudeHooks() : hasLegacyCodexHooks(),
  }).then((outcome) => console.log('[Desktop] Existing hooks:', JSON.stringify(outcome)));
  rpc = createDesktopRPC(
    host,
    bridge,
    (event) => {
      void rpc.send.event(event);
    },
    nativeServices,
    consent,
    updates,
  );
  const windowRoot = desktopRoot();
  const restored = await loadWindowState(windowRoot);
  const frame = initialFrame(restored, Screen.getAllDisplays());
  const windowSaver = createWindowStateSaver((state) => saveWindowState(windowRoot, state));
  let normalBounds = frame;
  window = new BrowserWindow({
    title: 'Pixel Agents',
    url: 'views://mainview/index.html',
    frame,
    renderer: 'cef',
    rpc,
    navigationRules: 'views://mainview/*',
  });
  if (restored?.maximized) window.maximize();
  // Only un-maximized bounds are remembered; maximize is stored as its own flag.
  const rememberWindow = () => {
    if (!window) return;
    const maximized = window.isMaximized();
    if (!maximized) normalBounds = window.getFrame();
    const state: WindowState = { schemaVersion: 1, bounds: normalBounds, maximized };
    windowSaver.update(state);
  };
  window.on('resize', rememberWindow);
  window.on('move', rememberWindow);
  const hookRegistration = host.hookServer.registration();
  if (!hookRegistration) {
    await host.stop('Hook server registration unavailable');
    await instanceLock.release();
    throw new Error('Hook server registration is unavailable');
  }
  await instanceLock.publish(hookRegistration.port);
  let previous = snapshot;
  host.subscribe((next) => {
    const previousAgents = new Map(previous.agents.map((agent) => [agent.agentId, agent]));
    const nextAgentIds = new Set(next.agents.map((agent) => agent.agentId));
    for (const agent of next.agents) {
      if (previousAgents.get(agent.agentId) !== agent)
        bridge.publish({ type: 'agentChanged', agent });
    }
    for (const agent of previous.agents) {
      if (!nextAgentIds.has(agent.agentId))
        bridge.publish({ type: 'agentRemoved', agentId: agent.agentId });
    }
    if (next.layoutRevision !== previous.layoutRevision)
      bridge.publish({
        type: 'layoutChanged',
        layout: next.layout,
        layoutRevision: next.layoutRevision,
      });
    bridge.publish({ type: 'runtimeStatusChanged', status: 'ready' });
    previous = next;
  });
  host.processes.on('changed', (operation) => {
    bridge.publish({
      type: 'operationChanged',
      operation: host.processes.operationState(operation),
    });
  });
  let shuttingDown: Promise<void> | undefined;
  let stopped = false;
  const shutdown = (reason: string) => {
    shuttingDown ??= (async () => {
      console.log(`[Desktop] Shutting down: ${reason}`);
      try {
        await windowSaver.flush();
        await host.stop(reason);
        await instanceLock.release();
        console.log('[Desktop] Shutdown complete');
      } catch (error) {
        // Quitting must still proceed; a stuck shutdown would otherwise trap the user's app open.
        console.error('[Desktop] Shutdown failed:', error);
      } finally {
        stopped = true;
        await logger.flush();
      }
    })();
    return shuttingDown;
  };
  window.on('close', () => {
    void shutdown('window close').then(() => app.quit());
  });
  // A quit request (menu, OS shutdown, SIGTERM) must not tear the runtime down while the host is
  // still stopping children, so it is vetoed until shutdown finished and then re-issued.
  Electrobun.events.on('before-quit', (event: { response: { allow: boolean } }) => {
    if (stopped) return;
    event.response = { allow: false };
    void shutdown('native quit').then(() => app.quit());
  });
  void window;
  process.once('SIGINT', () => void shutdown('SIGINT').then(() => app.quit()));
  process.once('SIGTERM', () => void shutdown('SIGTERM').then(() => app.quit()));
}

/** Startup failures are shown to the user with a way to reach the logs, then the app quits. */
async function reportStartupFailure(error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[Desktop] Startup failed:', error);
  try {
    const { response } = await Utils.showMessageBox({
      type: 'error',
      title: 'Pixel Agents could not start',
      message: 'Pixel Agents could not start.',
      detail: `${message}\n\nLogs: ${logRoot()}`,
      buttons: ['Open Log Folder', 'Quit'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) Utils.openPath(logRoot());
  } finally {
    app.quit();
  }
}

if (process.argv[1]?.endsWith('main.ts') || process.argv[1]?.endsWith('main.js'))
  void startDesktop().catch(reportStartupFailure);
