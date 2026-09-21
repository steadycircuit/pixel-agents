import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { stat } from 'node:fs/promises';
import * as path from 'node:path';

import type {
  AssetChunk,
  AssetId,
  DesktopAgent,
  DesktopConversation,
  DesktopSeat,
  DesktopSettings,
  DesktopSnapshot,
  DesktopWorkspace,
  OperationState,
  PreviousSessionRecord,
  ProviderId,
  RuntimeStatus,
  SessionKey,
  SessionKeyString,
} from '../../core/src/desktop/types.js';
import { getAgentDisplayName } from './agentNames.js';
import { buildAssetCache } from './assetReload.js';
import { readConversationPage } from './conversation.js';
import { type AssetCatalog, createAssetCatalog, EMPTY_CATALOG_VERSION } from './desktopAssets.js';
import { createHookServer, type HookServer } from './hookServer.js';
import {
  type DesktopProfile,
  openDesktopProfile,
  writeDesktopProfile,
} from './persistence/desktopProfile.js';
import { ProcessSupervisor } from './processSupervisor.js';
import { createProviderRegistry, type DesktopProviderRegistry } from './providerRegistry.js';
import type { ConsentStore } from './providers/hook/consentExecutor.js';
import { hooksConsentRequest } from './providers/hook/consentGate.js';
import { providerRegistry as bundledProviders } from './providers/index.js';
import { discoverSessions, locateTranscript } from './sessionDiscovery.js';

export interface RuntimeHostDeps {
  profileRoot?: string;
  /** Directory whose `assets/` subdirectory holds the bundled asset originals. */
  assetRoot?: string;
  appVersion?: string;
  onHookEvent?: (
    providerId: 'claude' | 'codex',
    event: Record<string, unknown>,
  ) => void | Promise<void>;
  onFocusRequested?: () => void | Promise<void>;
  providers?: DesktopProviderRegistry;
  hookToken?: string;
  instanceId?: string;
  /** Reads the provider's settings file: are our hook commands installed? Defaults to false. */
  hooksInstalled?: (providerId: ProviderId) => Promise<boolean>;
  /** Overrides each provider's transcript roots (tests, approved extra locations). */
  sessionRoots?: Partial<Record<ProviderId, string[]>>;
}
export interface RuntimeHost {
  start(): Promise<DesktopSnapshot>;
  stop(reason?: string): Promise<void>;
  snapshot(): DesktopSnapshot;
  /** Read-only, bounded access to the decoded asset catalog; never a general file read. */
  getAssetChunk(catalogVersion: string, assetId: AssetId, chunkIndex: number): AssetChunk;
  saveLayout(layout: unknown, expectedLayoutRevision: number): Promise<number>;
  saveSeats(
    seats: Record<SessionKeyString, DesktopSeat>,
    expectedSeatsRevision: number,
  ): Promise<number>;
  setSetting(key: keyof DesktopSettings, value: boolean | string): Promise<DesktopSettings>;
  setHooksEnabled(providerId: ProviderId, enabled: boolean): Promise<DesktopSettings>;
  /** The desktop consent repository: durable, per provider, over the desktop profile only. */
  consent: ConsentStore & { grant(providerId: string): Promise<void> };
  /** Re-reads install state from disk and re-derives the consent asks. */
  refreshHooks(): Promise<void>;
  launchAgent(
    providerId: ProviderId,
    workspaceId: string,
    initialPrompt?: string,
    bypassPermissions?: boolean,
  ): Promise<OperationState>;
  reEmploySession(sessionKey: SessionKey): Promise<OperationState>;
  /** Sessions on disk that are not live agents, with eligibility and the reason when not resumable. */
  listPreviousSessions(): Promise<PreviousSessionRecord[]>;
  sendAgentPrompt(agentId: number, prompt: string): Promise<OperationState>;
  focusAgent(agentId: number): DesktopAgent | undefined;
  closeAgent(agentId: number): Promise<void>;
  getAgentConversation(agentId: number, cursor?: string, limit?: number): DesktopConversation;
  addWorkspace(folder: string): Promise<DesktopWorkspace>;
  removeWorkspace(workspaceId: string): Promise<void>;
  cancelOperation(operationId: string): OperationState | undefined;
  operationStatus(operationId: string): OperationState | undefined;
  subscribe(listener: (snapshot: DesktopSnapshot) => void): () => void;
  processes: ProcessSupervisor;
  hookServer: HookServer;
}

/** Approved external asset directories that exist; a missing one is reported, not fatal. */
async function usableAssetDirectories(directories: string[]): Promise<string[]> {
  const usable: string[] = [];
  for (const directory of directories) {
    if (!path.isAbsolute(directory)) {
      console.warn(`[Desktop] Ignoring non-absolute asset directory: ${directory}`);
      continue;
    }
    if (
      await stat(directory).then(
        (s) => s.isDirectory(),
        () => false,
      )
    )
      usable.push(directory);
    else console.warn(`[Desktop] External asset directory is unavailable: ${directory}`);
  }
  return usable;
}

/** Desktop runtime lifecycle. Construction is side-effect free; start owns all resources. */
export function createRuntimeHost(deps: RuntimeHostDeps = {}): RuntimeHost {
  const events = new EventEmitter();
  const processes = new ProcessSupervisor();
  let handleHookEvent = async (
    _providerId: ProviderId,
    _event: Record<string, unknown>,
  ): Promise<void> => undefined;
  const hookServer = createHookServer({
    token: deps.hookToken,
    instanceId: deps.instanceId,
    onHookEvent: (providerId, event) => handleHookEvent(providerId, event),
    onFocus: () => deps.onFocusRequested?.(),
  });
  const providers = deps.providers ?? createProviderRegistry(bundledProviders);
  let profile: DesktopProfile | undefined;
  let status: RuntimeStatus = 'stopped';
  let stopPromise: Promise<void> | undefined;
  let persistQueue = Promise.resolve();
  let catalog: AssetCatalog | undefined;
  const locatedTranscripts = new Map<string, string>();
  const epoch = randomUUID();
  let current: DesktopSnapshot = {
    protocolVersion: 1,
    epoch,
    revision: 0,
    appVersion: deps.appVersion ?? '0.0.0',
    catalogVersion: EMPTY_CATALOG_VERSION,
    agents: [],
    seats: {},
    hooks: {
      claude: { installed: false, consent: 'unanswered' },
      codex: { installed: false, consent: 'unanswered' },
    },
    consentRequests: [],
    settings: {
      soundEnabled: true,
      alwaysShowLabels: false,
      ghostHeadlessAgents: false,
      watchAllSessions: false,
      showAreas: false,
      hooksInfoShown: false,
      workspaces: [],
      providerExecutables: {},
      hooksEnabled: { claude: false, codex: false },
    },
    providers: [
      {
        providerId: 'claude',
        available: false,
        canLaunch: false,
        canReply: false,
        supportsTeams: true,
      },
      {
        providerId: 'codex',
        available: false,
        canLaunch: false,
        canReply: false,
        supportsTeams: false,
      },
    ],
    layout: null,
    layoutRevision: 0,
    seatsRevision: 0,
  };
  const publish = () => {
    current = { ...current, revision: current.revision + 1 };
    events.emit('snapshot', current);
  };
  const consentOf = (providerId: string): 'granted' | 'declined' | 'unanswered' =>
    (providerId === 'claude' || providerId === 'codex'
      ? profile?.config.hooksConsent?.[providerId]
      : undefined) ?? 'unanswered';
  /** Applies a config change durably; a failed write leaves memory exactly as it was. */
  const mutateConfig = async (change: (config: NonNullable<typeof profile>['config']) => void) => {
    if (!profile) throw new Error('Runtime is not ready');
    const before = structuredClone(profile.config);
    change(profile.config);
    try {
      await writeDesktopProfile(profile);
    } catch (error) {
      profile.config = before;
      current = { ...current, settings: before.settings };
      throw error;
    }
    current = { ...current, settings: profile.config.settings };
  };
  const refreshHooks = async () => {
    if (!profile) return;
    const hooks = { ...current.hooks };
    const consentRequests: DesktopSnapshot['consentRequests'] = [];
    for (const providerId of ['claude', 'codex'] as const) {
      // A settings file we cannot read counts as "nothing installed": never act on a guess.
      const installed = await (deps.hooksInstalled?.(providerId) ?? Promise.resolve(false)).catch(
        () => false,
      );
      const consent = consentOf(providerId);
      hooks[providerId] = { installed, consent };
      const provider = providers.provider(providerId);
      const request =
        provider &&
        hooksConsentRequest(
          // The desktop preference defaults off, so "answered" alone retires the ask.
          {
            installed,
            hooksEnabled: true,
            consentAnswered: consent !== 'unanswered',
            privileged: true,
          },
          provider,
        );
      if (request)
        consentRequests.push({
          providerId,
          headline: request.headline,
          disclosure: request.disclosure,
        });
    }
    current = { ...current, hooks, consentRequests };
    publish();
  };
  const consentStore: RuntimeHost['consent'] = {
    get: consentOf,
    async grant(providerId) {
      if (providerId !== 'claude' && providerId !== 'codex') throw new Error('INVALID_ARGUMENT');
      await mutateConfig((config) => {
        // A grant replacing a decline also retracts that decline's hooks-off remnant in the same write.
        if (config.hooksConsent?.[providerId] === 'declined')
          config.settings.hooksEnabled[providerId] = false;
        config.hooksConsent = { ...config.hooksConsent, [providerId]: 'granted' };
      });
      await refreshHooks();
    },
    async recordDecline(providerId) {
      if (providerId !== 'claude' && providerId !== 'codex') throw new Error('INVALID_ARGUMENT');
      await mutateConfig((config) => {
        config.hooksConsent = { ...config.hooksConsent, [providerId]: 'declined' };
        config.settings.hooksEnabled[providerId] = false;
      });
      await refreshHooks();
    },
    async clearConsent(providerId) {
      if (providerId !== 'claude' && providerId !== 'codex') throw new Error('INVALID_ARGUMENT');
      await mutateConfig((config) => {
        const { [providerId]: _removed, ...rest } = config.hooksConsent ?? {};
        config.hooksConsent = rest;
      });
      await refreshHooks();
    },
    async clearAnswer(providerId) {
      if (providerId !== 'claude' && providerId !== 'codex') throw new Error('INVALID_ARGUMENT');
      await mutateConfig((config) => {
        const { [providerId]: _removed, ...rest } = config.hooksConsent ?? {};
        config.hooksConsent = rest;
        config.settings.hooksEnabled[providerId] = false; // the desktop default
      });
      await refreshHooks();
    },
  };
  handleHookEvent = async (providerId, raw) => {
    if (status !== 'ready' || !profile) throw new Error('SHUTTING_DOWN');
    const provider = providers.provider(providerId);
    const normalized = provider?.normalizeHookEvent(raw);
    if (!provider || provider.protocolVersion !== 1 || !normalized) return;
    const sessionKey = { providerId, sessionId: normalized.sessionId };
    const sessionKeyValue = `${providerId}:${normalized.sessionId}` as SessionKeyString;
    if (
      profile.state.dismissed.includes(sessionKeyValue) ||
      // Unqualified legacy dismissals apply to every provider until explicitly re-employed.
      profile.state.legacyDismissed?.includes(normalized.sessionId)
    )
      return;
    const existing = current.agents.find(
      (agent) =>
        agent.sessionKey.providerId === providerId &&
        agent.sessionKey.sessionId === normalized.sessionId,
    );
    const event = normalized.event;
    if (event.kind === 'sessionStart' && !existing)
      correlateLaunch(providerId, sessionKey, event.cwd);
    // Providers send `cwd` and `transcript_path` on EVERY hook event, not only SessionStart. A
    // session first seen mid-flight (started before hooks were installed, or after an app restart)
    // would otherwise never learn where it is running.
    const rawCwd = typeof raw['cwd'] === 'string' && raw['cwd'] ? raw['cwd'] : undefined;
    const rawTranscript =
      typeof raw['transcript_path'] === 'string' && raw['transcript_path']
        ? raw['transcript_path']
        : undefined;
    const cwd =
      (event.kind === 'sessionStart' && event.cwd ? event.cwd : undefined) ??
      rawCwd ??
      existing?.cwd ??
      '';
    const next: DesktopAgent = existing
      ? {
          ...existing,
          activity: existing.activity
            ? { ...existing.activity, tools: [...existing.activity.tools] }
            : undefined,
        }
      : {
          agentId: nextAgentId(current.agents),
          sessionKey,
          cwd,
          displayName: getAgentDisplayName(normalized.sessionId, folderNameFor(cwd)),
          isExternal: true,
          retained: true,
          dismissed: false,
          writerActive: false,
          status: 'idle',
          lastActivityAt: Date.now(),
          activity: { tools: [], permissionRequired: false, awaitingInput: false },
        };
    next.cwd = cwd;
    // An agent recorded before its folder was known carries the no-folder name; repair it now.
    if (cwd && next.displayName === getAgentDisplayName(normalized.sessionId, undefined))
      next.displayName = getAgentDisplayName(normalized.sessionId, folderNameFor(cwd));
    if (event.kind === 'sessionStart' && event.transcriptPath)
      next.transcriptPath = event.transcriptPath;
    else if (rawTranscript && !next.transcriptPath) next.transcriptPath = rawTranscript;
    next.lastActivityAt = Date.now();
    next.activity ??= { tools: [], permissionRequired: false, awaitingInput: false };
    applyAgentEvent(next, event, provider.formatToolStatus.bind(provider));
    current = {
      ...current,
      agents: [...current.agents.filter((agent) => agent.agentId !== next.agentId), next].sort(
        (a, b) => a.agentId - b.agentId,
      ),
    };
    profile.state.agents = current.agents;
    persistQueue = persistQueue.then(() => writeDesktopProfile(profile!));
    await persistQueue;
    publish();
    await deps.onHookEvent?.(providerId, raw);
  };
  return {
    consent: consentStore,
    refreshHooks,
    processes,
    hookServer,
    async start() {
      if (status === 'ready') return current;
      if (status === 'starting') return current;
      status = 'starting';
      try {
        profile = await openDesktopProfile(deps.profileRoot);
        current = {
          ...current,
          settings: profile.config.settings,
          agents: profile.state.agents,
          seats: profile.state.seats,
          seatsRevision: profile.state.seatsRevision ?? 0,
          layout: profile.layout.layout,
          layoutRevision: profile.layout.layoutRevision,
          providers: await providers.refresh(profile.config.settings),
        };
        if (deps.assetRoot) {
          try {
            catalog = createAssetCatalog(
              await buildAssetCache(
                deps.assetRoot,
                await usableAssetDirectories(profile.config.externalAssetDirectories ?? []),
              ),
            );
            current = { ...current, catalogVersion: catalog.version };
          } catch (error) {
            // The office stays usable with the built-in fallback; the failure is reported, not fatal.
            console.error('[Desktop] Asset catalog failed to load:', error);
          }
        }
        await refreshHooks();
        await hookServer.start();
        status = 'ready';
        publish();
        return current;
      } catch (error) {
        status = 'degraded';
        throw error;
      }
    },
    async stop() {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        status = 'stopping';
        await hookServer.stop();
        await processes.stop();
        if (profile) {
          profile.state = { ...profile.state };
        }
        status = 'stopped';
        publish();
      })();
      return stopPromise;
    },
    snapshot() {
      return current;
    },
    getAssetChunk(catalogVersion, assetId, chunkIndex) {
      if (!catalog || catalog.version !== catalogVersion) throw new Error('STALE_CLIENT');
      const chunk = catalog.chunk(assetId, chunkIndex);
      if (!chunk) throw new Error('NOT_FOUND');
      return chunk;
    },
    async saveLayout(layout, expectedLayoutRevision) {
      if (!profile) throw new Error('Runtime is not ready');
      if (current.layoutRevision !== expectedLayoutRevision) throw new Error('CONFLICT');
      const previous = { layout: profile.layout.layout, revision: profile.layout.layoutRevision };
      profile.layout.layout = layout;
      profile.layout.layoutRevision += 1;
      try {
        await writeDesktopProfile(profile);
      } catch (error) {
        profile.layout.layout = previous.layout;
        profile.layout.layoutRevision = previous.revision;
        throw error;
      }
      current = { ...current, layout, layoutRevision: profile.layout.layoutRevision };
      publish();
      return current.layoutRevision;
    },
    async saveSeats(seats, expectedSeatsRevision) {
      if (!profile) throw new Error('Runtime is not ready');
      if (current.seatsRevision !== expectedSeatsRevision) throw new Error('CONFLICT');
      const previous = { seats: profile.state.seats, revision: profile.state.seatsRevision };
      profile.state.seats = seats;
      profile.state.seatsRevision += 1;
      try {
        await writeDesktopProfile(profile);
      } catch (error) {
        profile.state.seats = previous.seats;
        profile.state.seatsRevision = previous.revision;
        throw error;
      }
      current = { ...current, seats, seatsRevision: profile.state.seatsRevision };
      publish();
      return current.seatsRevision;
    },
    async setSetting(key, value) {
      if (!profile) throw new Error('Runtime is not ready');
      if (typeof profile.config.settings[key] !== typeof value) throw new Error('INVALID_ARGUMENT');
      const settings = profile.config.settings as unknown as Record<string, unknown>;
      const previous = settings[key];
      settings[key] = value;
      try {
        await writeDesktopProfile(profile);
      } catch (error) {
        settings[key] = previous;
        throw error;
      }
      current = { ...current, settings: profile.config.settings };
      publish();
      return current.settings;
    },
    async setHooksEnabled(providerId, enabled) {
      if ((providerId !== 'claude' && providerId !== 'codex') || typeof enabled !== 'boolean')
        throw new Error('INVALID_ARGUMENT');
      await mutateConfig((config) => {
        config.settings.hooksEnabled[providerId] = enabled;
      });
      await refreshHooks();
      return current.settings;
    },
    async launchAgent(providerId, workspaceId, initialPrompt, bypassPermissions = false) {
      const workspace = current.settings.workspaces.find((item) => item.id === workspaceId);
      if (!workspace) throw new Error('NOT_FOUND');
      if (!(await stat(workspace.path)).isDirectory()) throw new Error('INVALID_ARGUMENT');
      const provider = providers.provider(providerId);
      const capability = providers.capabilities(providerId);
      if (!provider || !capability?.available || !capability.executable)
        throw new Error('PROVIDER_UNAVAILABLE');
      // Claude honours a supplied session id, so the launch is identified up front. Codex assigns
      // its own: it is correlated later from its SessionStart hook, and until then launches are
      // serialized per provider and folder so an arriving session can only belong to this one.
      const suppliesSessionId = providerId === 'claude';
      const sessionKey = suppliesSessionId ? { providerId, sessionId: randomUUID() } : undefined;
      const launch = provider.buildLaunchCommand?.(
        sessionKey?.sessionId ?? randomUUID(),
        workspace.path,
        {
          bypassPermissions,
          initialPrompt: initialPrompt ?? 'Start in this folder and wait for my next instruction.',
        },
      );
      if (!launch) throw new Error('UNSUPPORTED');
      const operation = await processes.spawnAcknowledged({
        providerId,
        sessionKey,
        lockKey: sessionKey ? undefined : `${providerId}:launch:${workspaceKey(workspace.path)}`,
        cwd: workspace.path,
        executable: capability.executable,
        args: launch.args,
        env: { ...process.env, ...launch.env },
      });
      return processes.operationState(operation);
    },
    async listPreviousSessions() {
      return scanPreviousSessions();
    },
    async reEmploySession(sessionKey) {
      if (!profile) throw new Error('Runtime is not ready');
      const known = current.agents.find(
        (item) =>
          item.sessionKey.providerId === sessionKey.providerId &&
          item.sessionKey.sessionId === sessionKey.sessionId,
      );
      if (known) {
        if (known.writerActive) throw new Error('SESSION_BUSY');
        return spawnPrompt(known, REEMPLOY_PROMPT);
      }
      // Not a live agent: it must be a discovered session. Discovery is re-run now so the writer
      // check reflects this moment, not the last time the roster was listed.
      const record = (await scanPreviousSessions()).find(
        (item) =>
          item.sessionKey.providerId === sessionKey.providerId &&
          item.sessionKey.sessionId === sessionKey.sessionId,
      );
      if (!record) throw new Error('NOT_FOUND');
      if (!record.eligible) throw new Error('SESSION_BUSY');
      const agent: DesktopAgent = {
        agentId: nextAgentId(current.agents),
        sessionKey: record.sessionKey,
        cwd: record.cwd,
        displayName: record.displayName,
        isExternal: false,
        retained: true,
        dismissed: false,
        writerActive: false,
        status: 'idle',
        lastActivityAt: Date.now(),
      };
      const operation = await spawnPrompt(agent, REEMPLOY_PROMPT);
      // Only after the OS acknowledged the spawn: clear the dismissal and keep the agent.
      const qualified = `${sessionKey.providerId}:${sessionKey.sessionId}`;
      const before = {
        agents: profile.state.agents,
        dismissed: profile.state.dismissed,
        legacy: profile.state.legacyDismissed,
      };
      profile.state.agents = [...current.agents, agent];
      profile.state.dismissed = profile.state.dismissed.filter((key) => key !== qualified);
      profile.state.legacyDismissed = (profile.state.legacyDismissed ?? []).filter(
        (id) => id !== sessionKey.sessionId,
      );
      try {
        await writeDesktopProfile(profile);
      } catch (error) {
        profile.state.agents = before.agents;
        profile.state.dismissed = before.dismissed;
        profile.state.legacyDismissed = before.legacy;
        throw error;
      }
      current = { ...current, agents: profile.state.agents };
      publish();
      return operation;
    },
    async sendAgentPrompt(agentId, prompt) {
      const agent = current.agents.find((item) => item.agentId === agentId);
      if (!agent) throw new Error('NOT_FOUND');
      if (agent.writerActive) throw new Error('SESSION_BUSY');
      return spawnPrompt(agent, prompt);
    },
    focusAgent(agentId) {
      return current.agents.find((agent) => agent.agentId === agentId);
    },
    async closeAgent(agentId) {
      if (!profile) throw new Error('Runtime is not ready');
      const agent = current.agents.find((candidate) => candidate.agentId === agentId);
      if (!agent) throw new Error('NOT_FOUND');
      const activeOperation = processes
        .list()
        .find(
          (operation) =>
            operation.sessionKey?.providerId === agent.sessionKey.providerId &&
            operation.sessionKey.sessionId === agent.sessionKey.sessionId &&
            operation.finishedAt === undefined,
        );
      if (activeOperation) throw new Error('SESSION_BUSY');
      const key =
        `${agent.sessionKey.providerId}:${agent.sessionKey.sessionId}` as SessionKeyString;
      const previous = { dismissed: profile.state.dismissed, agents: profile.state.agents };
      profile.state.dismissed = profile.state.dismissed.includes(key)
        ? profile.state.dismissed
        : [...profile.state.dismissed, key];
      const remaining = current.agents.filter((candidate) => candidate.agentId !== agentId);
      profile.state.agents = remaining;
      try {
        await writeDesktopProfile(profile);
      } catch (error) {
        // A dismissal that was not saved must not appear to have happened.
        profile.state.dismissed = previous.dismissed;
        profile.state.agents = previous.agents;
        throw error;
      }
      current = { ...current, agents: remaining };
      publish();
    },
    getAgentConversation(agentId, cursor, limit) {
      const agent = current.agents.find((candidate) => candidate.agentId === agentId);
      if (!agent) throw new Error('NOT_FOUND');
      const transcriptPath = agent.transcriptPath ?? locateKnownTranscript(agent);
      const page = transcriptPath
        ? readConversationPage(transcriptPath, cursor, limit)
        : { messages: [], historyRevision: 'unavailable' };
      return {
        sessionKey: agent.sessionKey,
        messages: page.messages,
        nextCursor: page.nextCursor,
        historyRevision: page.historyRevision,
      };
    },
    async addWorkspace(folder) {
      if (!profile || !path.isAbsolute(folder) || !(await stat(folder)).isDirectory())
        throw new Error('INVALID_ARGUMENT');
      const normalized = path.resolve(folder);
      const existing = current.settings.workspaces.find(
        (workspace) => workspace.path === normalized,
      );
      if (existing) return existing;
      const workspace: DesktopWorkspace = {
        id: randomUUID(),
        path: normalized,
        label: path.basename(normalized) || normalized,
      };
      profile.config.settings.workspaces = [...profile.config.settings.workspaces, workspace];
      await writeDesktopProfile(profile);
      current = { ...current, settings: profile.config.settings };
      publish();
      return workspace;
    },
    async removeWorkspace(workspaceId) {
      if (!profile) throw new Error('Runtime is not ready');
      if (!current.settings.workspaces.some((workspace) => workspace.id === workspaceId))
        throw new Error('NOT_FOUND');
      profile.config.settings.workspaces = profile.config.settings.workspaces.filter(
        (workspace) => workspace.id !== workspaceId,
      );
      await writeDesktopProfile(profile);
      current = { ...current, settings: profile.config.settings };
      publish();
    },
    cancelOperation(operationId) {
      const operation = processes.cancel(operationId);
      return operation ? processes.operationState(operation) : undefined;
    },
    operationStatus(operationId) {
      const operation = processes.get(operationId);
      return operation ? processes.operationState(operation) : undefined;
    },
    subscribe(listener) {
      events.on('snapshot', listener);
      return () => events.off('snapshot', listener);
    },
  };

  async function spawnPrompt(
    agent: DesktopSnapshot['agents'][number],
    prompt: string,
  ): Promise<OperationState> {
    const providerId = agent.sessionKey.providerId;
    const provider = providers.provider(providerId);
    const capability = providers.capabilities(providerId);
    if (!provider || !capability?.available || !capability.executable)
      throw new Error('PROVIDER_UNAVAILABLE');
    if (!(await stat(agent.cwd)).isDirectory()) throw new Error('INVALID_ARGUMENT');
    const command = provider.buildPromptCommand?.(agent.sessionKey.sessionId, agent.cwd, prompt);
    if (!command) throw new Error('UNSUPPORTED');
    const operation = await processes.spawnAcknowledged({
      providerId,
      sessionKey: agent.sessionKey,
      cwd: agent.cwd,
      executable: capability.executable,
      args: command.args,
      env: { ...process.env, ...command.env },
    });
    return processes.operationState(operation);
  }

  /** Canonical comparison key for a folder, so `/a/b/` and `/a/./b` name the same launch lock. */
  function workspaceKey(cwd: string): string {
    return path.resolve(cwd);
  }

  /**
   * Binds a just-started provider session to the app-owned launch that produced it. Launches are
   * serialized per provider and folder, so at most one un-bound operation can match; anything
   * else is an ordinary external session and is left alone.
   */
  function correlateLaunch(
    providerId: ProviderId,
    sessionKey: { providerId: ProviderId; sessionId: string },
    cwd: string | undefined,
  ): void {
    if (!cwd) return;
    const candidates = processes
      .list()
      .filter(
        (operation) =>
          operation.providerId === providerId &&
          !operation.sessionKey &&
          operation.finishedAt === undefined &&
          workspaceKey(operation.cwd) === workspaceKey(cwd),
      );
    if (candidates.length === 1) processes.bindSession(candidates[0]!.operationId, sessionKey);
  }

  /** Sessions first seen mid-flight never named their transcript; find it once and remember it. */
  function locateKnownTranscript(agent: DesktopAgent): string | undefined {
    const key = `${agent.sessionKey.providerId}:${agent.sessionKey.sessionId}`;
    const cached = locatedTranscripts.get(key);
    if (cached) return cached;
    const provider = providers.provider(agent.sessionKey.providerId);
    if (!provider) return undefined;
    const found = locateTranscript(
      provider,
      agent.sessionKey.sessionId,
      deps.sessionRoots?.[agent.sessionKey.providerId],
    );
    if (found) locatedTranscripts.set(key, found);
    return found;
  }

  async function scanPreviousSessions(): Promise<PreviousSessionRecord[]> {
    const records = (['claude', 'codex'] as const).flatMap((providerId) => {
      const provider = providers.provider(providerId);
      if (!provider) return [];
      const exclude = new Set(
        current.agents
          .filter((agent) => agent.sessionKey.providerId === providerId)
          .map((agent) => agent.sessionKey.sessionId),
      );
      return discoverSessions(provider, providerId, {
        roots: deps.sessionRoots?.[providerId],
        exclude,
      });
    });
    return records.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  /** The surname source: a registered workspace's label, else the folder's own name. */
  function folderNameFor(cwd: string): string | undefined {
    if (!cwd) return undefined;
    return (
      current.settings.workspaces.find((workspace) => workspace.path === cwd)?.label ??
      (path.basename(cwd) || undefined)
    );
  }
}

const REEMPLOY_PROMPT =
  'You are being re-employed. Resume this work and wait for my next instruction.';

function nextAgentId(agents: DesktopAgent[]): number {
  return agents.reduce((maximum, agent) => Math.max(maximum, agent.agentId), 0) + 1;
}

function applyAgentEvent(
  agent: DesktopAgent,
  event: import('../../core/src/provider.js').AgentEvent,
  formatStatus: (toolName: string, input?: unknown) => string,
): void {
  const activity = (agent.activity ??= {
    tools: [],
    permissionRequired: false,
    awaitingInput: false,
  });
  switch (event.kind) {
    case 'toolStart':
    case 'subagentStart':
      activity.tools = [
        ...activity.tools.filter((tool) => tool.toolId !== event.toolId),
        {
          toolId: event.toolId,
          toolName: event.toolName,
          status: formatStatus(event.toolName, event.input),
        },
      ];
      activity.permissionRequired = false;
      activity.awaitingInput = false;
      agent.status = 'working';
      break;
    case 'toolEnd':
    case 'subagentEnd':
      activity.tools = activity.tools.filter((tool) =>
        event.toolId === 'current' ? false : tool.toolId !== event.toolId,
      );
      activity.permissionRequired = false;
      agent.status = activity.tools.length ? 'working' : 'idle';
      break;
    case 'permissionRequest':
      activity.permissionRequired = true;
      agent.status = 'waiting';
      break;
    case 'turnEnd':
      activity.tools = [];
      activity.permissionRequired = false;
      activity.awaitingInput = event.awaitingInput === true;
      agent.status = event.awaitingInput ? 'waiting' : 'idle';
      break;
    case 'sessionStart':
      activity.awaitingInput = false;
      agent.status = 'idle';
      break;
    case 'sessionEnd':
      activity.tools = [];
      activity.permissionRequired = false;
      activity.awaitingInput = false;
      agent.status = 'ended';
      break;
    case 'progress':
      agent.status = 'working';
      break;
    case 'subagentTurnEnd':
      agent.status = event.reason === 'idle' ? 'waiting' : 'idle';
      break;
  }
}
