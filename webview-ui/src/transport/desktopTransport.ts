import { Electroview } from 'electrobun/view';

import {
  TRANSPORT_STATE_CONNECTED,
  TRANSPORT_STATE_DISCONNECTED,
} from '../../../core/src/constants.js';
import type { DesktopMessages, DesktopRequests } from '../../../core/src/desktop/requests.js';
import type {
  DesktopSeat,
  DesktopSnapshot,
  EventEnvelope,
  PreviousSessionRecord,
  SessionKeyString,
} from '../../../core/src/desktop/types.js';
import type { ClientMessage, ServerMessage } from '../../../core/src/messages.js';
import { type FetchAssetChunk, loadCatalog } from './desktopAssets.js';
import type { DesktopClientState } from './desktopClientState.js';
import { reduceEnvelope, snapshotMessages, withSavedRevisions } from './desktopClientState.js';
import type { MessageTransport, TransportState } from './types.js';

type DesktopRpcSchema = {
  bun: { requests: DesktopRequests; messages: Record<string, never> };
  webview: { requests: Record<string, never>; messages: DesktopMessages };
};

/** Compatibility adapter while the office reducer moves from legacy messages
 * to revisioned desktop events. It never opens an application WebSocket. */
export class DesktopTransport implements MessageTransport {
  private readonly handlers: Array<(message: ServerMessage) => void> = [];
  private readonly clientId = crypto.randomUUID();
  private client: DesktopClientState | undefined;
  private bootstrapping: Promise<void> | undefined;
  private previous: PreviousSessionRecord[] = [];
  private loadedCatalog: { version: string; defaultLayout: unknown } | undefined;
  /** Events that raced ahead of the bootstrap response that names their subscription. */
  private readonly early: EventEnvelope[] = [];
  private readonly rpc = Electroview.defineRPC<DesktopRpcSchema>({
    handlers: {
      requests: {},
      messages: { event: (envelope: EventEnvelope) => this.handleEvent(envelope) },
    },
  });
  private readonly view = new Electroview({ rpc: this.rpc });
  private _state: TransportState = TRANSPORT_STATE_CONNECTED;
  readonly ready = Promise.resolve();

  get state(): TransportState {
    return this._state;
  }

  send(message: ClientMessage): void {
    if (message.type === 'webviewReady') void this.bootstrap();
    if (message.type === 'saveLayout') void this.saveLayout(message.layout);
    if (message.type === 'saveAgentSeats') void this.saveSeats(message.seats);
    if (message.type === 'launchAgent') void this.launchAgent(message);
    if (message.type === 'sendAgentPrompt') void this.sendPrompt(message.id, message.prompt);
    if (message.type === 'requestAgentConversation') void this.getConversation(message.id);
    if (message.type === 'focusAgent') void this.focusAgent(message.id);
    if (message.type === 'closeAgent') void this.closeAgent(message.id);
    if (message.type === 'setSoundEnabled') void this.saveSetting('soundEnabled', message.enabled);
    if (message.type === 'setAlwaysShowLabels')
      void this.saveSetting('alwaysShowLabels', message.enabled);
    if (message.type === 'setGhostHeadlessAgents')
      void this.saveSetting('ghostHeadlessAgents', message.enabled);
    if (message.type === 'setWatchAllSessions')
      void this.saveSetting('watchAllSessions', message.enabled);
    if (message.type === 'setHooksInfoShown') void this.saveSetting('hooksInfoShown', true);
    if (message.type === 'setShowAreas') void this.saveSetting('showAreas', message.enabled);
    if (message.type === 'hooksConsentResponse') void this.answerConsent(message);
    if (message.type === 'setHooksEnabled')
      void this.setHooksEnabled(message.providerId, message.enabled);
  }

  onMessage(handler: (message: ServerMessage) => void): () => void {
    this.handlers.push(handler);
    return () => {
      const index = this.handlers.indexOf(handler);
      if (index >= 0) this.handlers.splice(index, 1);
    };
  }

  onStateChange(handler: (state: TransportState) => void): () => void {
    handler(this._state);
    return () => {};
  }

  dispose(): void {
    this._state = TRANSPORT_STATE_DISCONNECTED;
  }

  private get epoch(): string {
    return this.client?.snapshot.epoch ?? '';
  }

  private get snapshot(): DesktopSnapshot | undefined {
    return this.client?.snapshot;
  }

  private bootstrap(): Promise<void> {
    this.bootstrapping ??= this.runBootstrap().finally(() => {
      this.bootstrapping = undefined;
    });
    return this.bootstrapping;
  }

  private async runBootstrap(retryStaleCatalog = true): Promise<void> {
    void this.view;
    const result = await this.rpc.request.getBootstrapState({
      clientId: this.clientId,
      protocolVersion: 1,
    });
    if (!result.ok) return;
    const snapshot = result.value.snapshot as DesktopSnapshot;
    const assetMessages: ServerMessage[] = [];
    if (this.loadedCatalog?.version !== snapshot.catalogVersion) {
      try {
        const loaded = await loadCatalog(this.fetchAssetChunk(snapshot.catalogVersion));
        assetMessages.push(...loaded.messages);
        this.loadedCatalog = {
          version: snapshot.catalogVersion,
          defaultLayout: loaded.defaultLayout,
        };
      } catch (error) {
        void this.rpc.request.releaseSubscription({ subscriptionId: result.value.subscriptionId });
        if (retryStaleCatalog && error instanceof Error && error.message === 'STALE_CLIENT')
          return this.runBootstrap(false);
        console.error('[Webview] Desktop assets failed to load:', error);
        return;
      }
    }
    const previous = this.client;
    this.client = { subscriptionId: result.value.subscriptionId, snapshot };
    if (previous)
      void this.rpc.request.releaseSubscription({ subscriptionId: previous.subscriptionId });
    // Assets first: the office needs sprites and tiles before it can place agents or a layout.
    for (const message of assetMessages) this.emit(message);
    // A new host epoch invalidates everything the office holds, so it is loaded like a first start.
    const sameHost = previous?.snapshot.epoch === snapshot.epoch;
    for (const message of snapshotMessages(
      sameHost ? previous?.snapshot : undefined,
      snapshot,
      this.loadedCatalog?.defaultLayout,
    ))
      this.emit(message);
    for (const envelope of this.early.splice(0)) this.handleEvent(envelope);
    await this.refreshPreviousSessions();
  }

  /** Lists resumable sessions for the roster; failures leave the roster as it was. */
  private async refreshPreviousSessions(): Promise<void> {
    const result = await this.rpc.request.listPreviousSessions({ clientId: this.clientId });
    if (!result.ok) return;
    this.previous = result.value;
    this.emit({
      type: 'previousSessions',
      sessions: result.value
        .filter((record) => record.eligible)
        .map((record) => ({
          sessionId: record.sessionKey.sessionId,
          displayName: record.displayName,
          folderName: record.folderName,
          folderPath: record.cwd,
          lastActivity: new Date(record.lastActivityAt).toISOString(),
        })),
    });
  }

  private fetchAssetChunk(catalogVersion: string): FetchAssetChunk {
    return async (assetId, chunkIndex) => {
      const result = await this.rpc.request.getAssetChunk({ catalogVersion, assetId, chunkIndex });
      if (!result.ok) throw new Error(result.error.code);
      return result.value;
    };
  }

  private handleEvent(envelope: EventEnvelope): void {
    if (this.bootstrapping || !this.client) {
      this.early.push(envelope);
      return;
    }
    const outcome = reduceEnvelope(this.client, envelope);
    if (outcome.kind === 'ignored') return;
    if (outcome.kind === 'resync') {
      console.warn(`[Webview] Desktop state resync: ${outcome.reason}`);
      void this.bootstrap();
      return;
    }
    this.client = outcome.state;
    for (const message of outcome.messages) this.emit(message);
  }

  private async saveLayout(layout: Record<string, unknown>): Promise<void> {
    if (!this.epoch) return;
    const result = await this.rpc.request.saveLayout({
      requestId: crypto.randomUUID(),
      clientId: this.clientId,
      epoch: this.epoch,
      layout,
      expectedLayoutRevision: this.snapshot?.layoutRevision ?? 0,
    });
    if (result.ok && this.client)
      this.client = withSavedRevisions(this.client, {
        layoutRevision: result.value.layoutRevision,
      });
  }

  private async saveSetting(
    key:
      | 'soundEnabled'
      | 'alwaysShowLabels'
      | 'ghostHeadlessAgents'
      | 'watchAllSessions'
      | 'showAreas'
      | 'hooksInfoShown',
    value: boolean,
  ): Promise<void> {
    if (!this.epoch) return;
    await this.rpc.request.setSetting({
      requestId: crypto.randomUUID(),
      clientId: this.clientId,
      epoch: this.epoch,
      key,
      value,
    });
  }

  private async answerConsent(
    message: Extract<ClientMessage, { type: 'hooksConsentResponse' }>,
  ): Promise<void> {
    const { providerId, choice } = message;
    if (!this.epoch || (providerId !== 'claude' && providerId !== 'codex')) return;
    const result = await this.rpc.request.answerHooksConsent({
      requestId: crypto.randomUUID(),
      clientId: this.clientId,
      epoch: this.epoch,
      providerId,
      choice,
    });
    // The closing Intro step reports the install OUTCOME, so re-derive it from the host's truth.
    if (result.ok) await this.bootstrap();
  }

  private async setHooksEnabled(providerId: string, enabled: boolean): Promise<void> {
    if (!this.epoch || (providerId !== 'claude' && providerId !== 'codex')) return;
    const result = await this.rpc.request.setHooksEnabled({
      requestId: crypto.randomUUID(),
      clientId: this.clientId,
      epoch: this.epoch,
      providerId,
      enabled,
    });
    // The existing renderer consumes settingsLoaded, so refresh that
    // compatibility snapshot only after the guarded native change succeeds.
    if (result.ok) await this.bootstrap();
  }

  private async saveSeats(
    seats: Record<string, { palette: number; hueShift: number; seatId: string | null }>,
  ): Promise<void> {
    if (!this.epoch || !this.snapshot) return;
    const byAgentId = new Map(this.snapshot.agents.map((agent) => [agent.agentId, agent]));
    const durableSeats = Object.fromEntries(
      Object.entries(seats).flatMap(([agentId, seat]) => {
        const agent = byAgentId.get(Number(agentId));
        if (!agent) return [];
        return [
          [
            `${agent.sessionKey.providerId}:${agent.sessionKey.sessionId}`,
            {
              palette: seat.palette,
              hueShift: seat.hueShift,
              ...(seat.seatId === null ? {} : { seatId: seat.seatId }),
            },
          ],
        ];
      }),
    ) as Record<SessionKeyString, DesktopSeat>;
    const result = await this.rpc.request.saveAgentSeats({
      requestId: crypto.randomUUID(),
      clientId: this.clientId,
      epoch: this.epoch,
      seats: durableSeats,
      expectedSeatsRevision: this.snapshot.seatsRevision,
    });
    if (result.ok && this.client)
      this.client = withSavedRevisions(this.client, { seatsRevision: result.value.seatsRevision });
  }

  private async launchAgent(
    message: Extract<ClientMessage, { type: 'launchAgent' }>,
  ): Promise<void> {
    if (!this.epoch || !this.snapshot) return;
    if (message.sessionId) {
      // A live/retained agent, or a discovered previous session: both are addressed by their
      // provider-qualified key, never by the bare id the roster shows.
      const sessionKey = (
        this.snapshot.agents.find(
          (candidate) => candidate.sessionKey.sessionId === message.sessionId,
        ) ?? this.previous.find((record) => record.sessionKey.sessionId === message.sessionId)
      )?.sessionKey;
      if (!sessionKey) return;
      const result = await this.rpc.request.reEmploySession({
        requestId: crypto.randomUUID(),
        clientId: this.clientId,
        epoch: this.epoch,
        sessionKey,
      });
      if (result.ok) await this.refreshPreviousSessions();
      return;
    }
    let workspace = message.folderPath
      ? this.snapshot.settings.workspaces.find((candidate) => candidate.path === message.folderPath)
      : this.snapshot.settings.workspaces[0];
    if (!workspace && !message.folderPath) {
      const selection = await this.rpc.request.selectFolder({
        clientId: this.clientId,
        purpose: 'workspace',
      });
      if (!selection.ok || !selection.value) return;
      const added = await this.rpc.request.addWorkspace({
        requestId: crypto.randomUUID(),
        clientId: this.clientId,
        epoch: this.epoch,
        selectionId: selection.value.selectionId,
      });
      if (!added.ok) return;
      workspace = added.value;
      if (this.client) {
        const settings = this.client.snapshot.settings;
        this.client = {
          ...this.client,
          snapshot: {
            ...this.client.snapshot,
            settings: { ...settings, workspaces: [...settings.workspaces, workspace] },
          },
        };
        this.emit({
          type: 'workspaceFolders',
          folders: this.client.snapshot.settings.workspaces.map((entry) => ({
            name: entry.label,
            path: entry.path,
          })),
        });
      }
    }
    if (!workspace) return;
    await this.rpc.request.launchAgent({
      requestId: crypto.randomUUID(),
      clientId: this.clientId,
      epoch: this.epoch,
      providerId: 'claude',
      workspaceId: workspace.id,
      bypassPermissions: message.bypassPermissions === true,
    });
  }

  private async sendPrompt(agentId: number, prompt: string): Promise<void> {
    if (!this.epoch) return;
    await this.rpc.request.sendAgentPrompt({
      requestId: crypto.randomUUID(),
      clientId: this.clientId,
      epoch: this.epoch,
      agentId,
      prompt,
    });
  }

  private async getConversation(agentId: number): Promise<void> {
    const result = await this.rpc.request.getAgentConversation({ agentId, limit: 200 });
    if (result.ok)
      this.emit({ type: 'agentConversation', id: agentId, messages: result.value.messages });
  }

  private async focusAgent(agentId: number): Promise<void> {
    const result = await this.rpc.request.focusAgent({ agentId });
    if (result.ok) this.emit({ type: 'agentSelected', id: result.value.agentId });
  }

  private async closeAgent(agentId: number): Promise<void> {
    if (!this.epoch) return;
    await this.rpc.request.closeAgent({
      requestId: crypto.randomUUID(),
      clientId: this.clientId,
      epoch: this.epoch,
      agentId,
    });
  }

  private emit(message: ServerMessage): void {
    for (const handler of this.handlers) handler(message);
  }
}
