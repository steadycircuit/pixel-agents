import type {
  DesktopAgent,
  DesktopSnapshot,
  EventEnvelope,
} from '../../../core/src/desktop/types.js';
import { sessionKeyString } from '../../../core/src/desktop/types.js';
import type { ServerMessage } from '../../../core/src/messages.js';

/** DOM-free client state for the desktop protocol: applies revisioned events to a snapshot and
 * translates the differences into the legacy renderer messages. */
export interface DesktopClientState {
  subscriptionId: string;
  snapshot: DesktopSnapshot;
}

export type ReduceOutcome =
  | { kind: 'applied'; state: DesktopClientState; messages: ServerMessage[] }
  /** Event belongs to a released subscription or was already applied; nothing changes. */
  | { kind: 'ignored'; state: DesktopClientState }
  /** The event stream can no longer be trusted; the caller must bootstrap again. */
  | { kind: 'resync'; reason: string };

export function reduceEnvelope(state: DesktopClientState, envelope: EventEnvelope): ReduceOutcome {
  if (envelope.subscriptionId !== state.subscriptionId) return { kind: 'ignored', state };
  if (envelope.protocolVersion !== 1) return { kind: 'resync', reason: 'protocol version changed' };
  if (envelope.epoch !== state.snapshot.epoch) return { kind: 'resync', reason: 'host restarted' };
  if (envelope.revision <= state.snapshot.revision) return { kind: 'ignored', state };
  if (envelope.revision !== state.snapshot.revision + 1)
    return { kind: 'resync', reason: 'missed events' };

  const event = envelope.event;
  if (event.type === 'resyncRequired') return { kind: 'resync', reason: event.reason };

  let snapshot: DesktopSnapshot = { ...state.snapshot, revision: envelope.revision };
  const messages: ServerMessage[] = [];
  if (event.type === 'agentChanged') {
    const previous = snapshot.agents.find((agent) => agent.agentId === event.agent.agentId);
    snapshot = {
      ...snapshot,
      agents: previous
        ? snapshot.agents.map((agent) => (agent === previous ? event.agent : agent))
        : [...snapshot.agents, event.agent].sort((a, b) => a.agentId - b.agentId),
    };
    messages.push(...agentMessages(previous, event.agent));
  } else if (event.type === 'agentRemoved') {
    if (snapshot.agents.some((agent) => agent.agentId === event.agentId)) {
      snapshot = {
        ...snapshot,
        agents: snapshot.agents.filter((agent) => agent.agentId !== event.agentId),
      };
      messages.push({ type: 'agentClosed', id: event.agentId });
    }
  } else if (event.type === 'layoutChanged') {
    // Our own save already advanced layoutRevision from its RPC response; only foreign changes reload.
    if (event.layoutRevision > snapshot.layoutRevision) {
      snapshot = { ...snapshot, layout: event.layout, layoutRevision: event.layoutRevision };
      messages.push({ type: 'layoutLoaded', layout: event.layout as Record<string, never> | null });
    }
  }
  // operationChanged / runtimeStatusChanged / diagnosticEvent advance the revision only.
  return { kind: 'applied', state: { ...state, snapshot }, messages };
}

/** Records a save the client itself made so the host's echo event is not replayed as a reload. */
export function withSavedRevisions(
  state: DesktopClientState,
  saved: { layoutRevision?: number; seatsRevision?: number },
): DesktopClientState {
  return {
    ...state,
    snapshot: {
      ...state.snapshot,
      layoutRevision: Math.max(state.snapshot.layoutRevision, saved.layoutRevision ?? 0),
      seatsRevision: Math.max(state.snapshot.seatsRevision, saved.seatsRevision ?? 0),
    },
  };
}

/** Messages that bring a renderer holding `previous` (or nothing) up to `next`. */
export function snapshotMessages(
  previous: DesktopSnapshot | undefined,
  next: DesktopSnapshot,
  /** Bundled default layout, shown only while the profile has never saved one. */
  fallbackLayout?: unknown,
): ServerMessage[] {
  const layout = (next.layout ?? fallbackLayout ?? null) as Record<string, never> | null;
  const messages: ServerMessage[] = [
    {
      type: 'settingsLoaded',
      soundEnabled: next.settings.soundEnabled,
      alwaysShowLabels: next.settings.alwaysShowLabels,
      ghostHeadlessAgents: next.settings.ghostHeadlessAgents,
      watchAllSessions: next.settings.watchAllSessions,
      showAreas: next.settings.showAreas,
      hooksEnabled: next.settings.hooksEnabled.claude,
      hooksInfoShown: next.settings.hooksInfoShown,
      lastSeenVersion: '',
      extensionVersion: next.appVersion,
      externalAssetDirectories: [],
    },
    {
      type: 'workspaceFolders',
      folders: next.settings.workspaces.map((workspace) => ({
        name: workspace.label,
        path: workspace.path,
      })),
    },
    // Install state per provider: the Settings checkbox binds to this, never to the preference.
    ...(['claude', 'codex'] as const).map((providerId) => ({
      type: 'hooksStatus' as const,
      providerId,
      installed: next.hooks[providerId].installed,
    })),
  ];
  if (!previous) {
    messages.push(
      {
        type: 'existingAgents',
        agents: next.agents.map((agent) => agent.agentId),
        agentMeta: Object.fromEntries(
          next.agents.map((agent) => [
            agent.agentId,
            { palette: agent.palette, hueShift: agent.hueShift, seatId: seatIdFor(next, agent) },
          ]),
        ),
        folderNames: {},
        externalAgents: Object.fromEntries(
          next.agents.map((agent) => [agent.agentId, agent.isExternal]),
        ),
        displayNames: Object.fromEntries(
          next.agents.map((agent) => [agent.agentId, agent.displayName]),
        ),
        agentProviders: Object.fromEntries(
          next.agents.map((agent) => [agent.agentId, agent.sessionKey.providerId]),
        ),
      },
      { type: 'layoutLoaded', layout },
      // The first-run asks come last, once the office they are spoken in exists.
      ...next.consentRequests.map((request) => ({
        type: 'hooksConsentRequest' as const,
        providerId: request.providerId,
        headline: request.headline,
        disclosure: request.disclosure,
      })),
    );
    return messages;
  }
  const nextIds = new Set(next.agents.map((agent) => agent.agentId));
  for (const agent of previous.agents)
    if (!nextIds.has(agent.agentId)) messages.push({ type: 'agentClosed', id: agent.agentId });
  const previousById = new Map(previous.agents.map((agent) => [agent.agentId, agent]));
  for (const agent of next.agents)
    messages.push(...agentMessages(previousById.get(agent.agentId), agent));
  if (next.layoutRevision !== previous.layoutRevision || next.epoch !== previous.epoch)
    messages.push({ type: 'layoutLoaded', layout });
  return messages;
}

function seatIdFor(snapshot: DesktopSnapshot, agent: DesktopAgent): string | undefined {
  return snapshot.seats[sessionKeyString(agent.sessionKey)]?.seatId;
}

function agentMessages(previous: DesktopAgent | undefined, next: DesktopAgent): ServerMessage[] {
  const messages: ServerMessage[] = [];
  if (!previous)
    messages.push({
      type: 'agentCreated',
      id: next.agentId,
      displayName: next.displayName,
      folderName: next.cwd.split(/[\\/]/).filter(Boolean).at(-1),
      isExternal: next.isExternal,
      palette: next.palette,
      hueShift: next.hueShift,
      providerId: next.sessionKey.providerId,
    });
  const previousTools = new Map(previous?.activity?.tools.map((tool) => [tool.toolId, tool]));
  const nextTools = new Map(next.activity?.tools.map((tool) => [tool.toolId, tool]));
  for (const tool of nextTools.values())
    if (!previousTools.has(tool.toolId))
      messages.push({
        type: 'agentToolStart',
        id: next.agentId,
        toolId: tool.toolId,
        toolName: tool.toolName,
        status: tool.status,
        permissionActive: next.activity?.permissionRequired,
      });
  for (const tool of previousTools.values())
    if (!nextTools.has(tool.toolId))
      messages.push({ type: 'agentToolDone', id: next.agentId, toolId: tool.toolId });
  const wasBlocked = previous?.activity?.permissionRequired === true;
  const isBlocked = next.activity?.permissionRequired === true;
  if (wasBlocked && !isBlocked)
    messages.push({ type: 'agentToolPermissionClear', id: next.agentId });
  // A permission-blocked agent is mid-turn: legacy 'waiting' means "turn finished" and its bubble
  // would replace the permission bubble, so blocked agents stay 'active'.
  const legacyStatus = (agent: DesktopAgent | undefined) =>
    agent === undefined
      ? undefined
      : agent.status === 'working' || agent.activity?.permissionRequired
        ? 'active'
        : 'waiting';
  if (legacyStatus(previous) !== legacyStatus(next))
    messages.push({
      type: 'agentStatus',
      id: next.agentId,
      status: legacyStatus(next) as 'active' | 'waiting',
      awaitingInput: next.activity?.awaitingInput,
    });
  if (!wasBlocked && isBlocked) messages.push({ type: 'agentToolPermission', id: next.agentId });
  return messages;
}
