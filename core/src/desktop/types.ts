/** JSON-safe contracts shared by the Electrobun host and renderer. */
export type ProviderId = 'claude' | 'codex';
export interface SessionKey {
  providerId: ProviderId;
  sessionId: string;
}
export type SessionKeyString = `${ProviderId}:${string}`;
export function sessionKeyString(key: SessionKey): SessionKeyString {
  return `${key.providerId}:${key.sessionId}` as SessionKeyString;
}
export interface DesktopAgent {
  agentId: number;
  sessionKey: SessionKey;
  cwd: string;
  /** Host-recorded transcript location; never accepted from renderer requests. */
  transcriptPath?: string;
  displayName: string;
  palette?: number;
  hueShift?: number;
  isExternal: boolean;
  retained: boolean;
  dismissed: boolean;
  writerActive: boolean;
  status: 'idle' | 'working' | 'waiting' | 'ended';
  lastActivityAt: number;
  activity?: {
    tools: Array<{ toolId: string; toolName: string; status: string }>;
    permissionRequired: boolean;
    awaitingInput: boolean;
  };
}
export interface DesktopSeat {
  palette?: number;
  hueShift?: number;
  seatId?: string;
}
export interface DesktopWorkspace {
  id: string;
  path: string;
  label: string;
}
export interface ProviderCapabilities {
  providerId: ProviderId;
  available: boolean;
  canLaunch: boolean;
  canReply: boolean;
  supportsTeams: boolean;
  executable?: string;
  version?: string;
  error?: string;
}
export interface DesktopSettings {
  soundEnabled: boolean;
  alwaysShowLabels: boolean;
  ghostHeadlessAgents: boolean;
  watchAllSessions: boolean;
  showAreas: boolean;
  /** The "Instant Detection Active" tip has been dismissed; it never returns once true. */
  hooksInfoShown: boolean;
  workspaces: DesktopWorkspace[];
  providerExecutables: Partial<Record<ProviderId, string>>;
  hooksEnabled: Record<ProviderId, boolean>;
}
export type ConsentState = 'granted' | 'declined' | 'unanswered';
export type ConsentChoice = 'install' | 'notNow' | 'never';
export interface HookProviderStatus {
  /** Are any of our hook commands on disk in the provider's settings right now? */
  installed: boolean;
  consent: ConsentState;
}
/** A first-run ask the renderer must show; produced by the provider-agnostic consent gate. */
export interface ConsentRequest {
  providerId: ProviderId;
  headline: string;
  disclosure: string;
}
/** A session on disk that is not currently an agent, offered for re-employment. */
export interface PreviousSessionRecord {
  sessionKey: SessionKey;
  displayName: string;
  folderName: string;
  /** Working directory the session ran in (from the transcript, never renderer-supplied). */
  cwd: string;
  lastActivityAt: number;
  /** False while another process may be writing the session: history stays readable, resume is off. */
  eligible: boolean;
  reason?: string;
}
export interface DesktopSnapshot {
  protocolVersion: 1;
  epoch: string;
  revision: number;
  appVersion: string;
  /** Immutable identifier of the loaded bundled/external asset catalog. */
  catalogVersion: string;
  agents: DesktopAgent[];
  seats: Record<SessionKeyString, DesktopSeat>;
  settings: DesktopSettings;
  hooks: Record<ProviderId, HookProviderStatus>;
  consentRequests: ConsentRequest[];
  providers: ProviderCapabilities[];
  layout: unknown;
  layoutRevision: number;
  seatsRevision: number;
}
export type ErrorCode =
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'UNSUPPORTED'
  | 'PROVIDER_UNAVAILABLE'
  | 'SESSION_BUSY'
  | 'CONSENT_REQUIRED'
  | 'CANCELLED'
  | 'CONFLICT'
  | 'IO_ERROR'
  | 'SPAWN_FAILED'
  | 'STALE_CLIENT'
  | 'SHUTTING_DOWN'
  | 'INTERNAL';
export interface RpcError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  correlationId?: string;
}
export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: RpcError };
export interface MutationContext {
  requestId: string;
  clientId: string;
  epoch: string;
}
export interface EventEnvelope {
  protocolVersion: 1;
  subscriptionId: string;
  epoch: string;
  revision: number;
  event: DesktopEvent;
}
export type DesktopEvent =
  | { type: 'agentChanged'; agent: DesktopAgent }
  | { type: 'agentRemoved'; agentId: number }
  | { type: 'operationChanged'; operation: OperationState }
  | { type: 'runtimeStatusChanged'; status: RuntimeStatus }
  | { type: 'updateStateChanged'; state: UpdateState }
  | { type: 'layoutChanged'; layout: unknown; layoutRevision: number }
  | { type: 'diagnosticEvent'; message: string }
  | { type: 'resyncRequired'; reason: string };
export interface OperationState {
  operationId: string;
  providerId: ProviderId;
  sessionKey?: SessionKey;
  state: 'starting' | 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: number;
  finishedAt?: number;
  error?: RpcError;
}
export interface DesktopConversation {
  sessionKey: SessionKey;
  messages: Array<{ role: 'user' | 'assistant'; text: string; timestamp?: string }>;
  nextCursor?: string;
  historyRevision: string;
}
export const ASSET_IDS = [
  'characters',
  'pets',
  'floors',
  'walls',
  'carpets',
  'furniture',
  'defaultLayout',
] as const;
export type AssetId = (typeof ASSET_IDS)[number];
export interface AssetChunk {
  chunk: string;
  chunkIndex: number;
  chunkCount: number;
  /** SHA-256 (hex) of the complete serialized asset, not of this chunk. */
  sha256: string;
}
export type UpdatePhase =
  'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'applying' | 'error';
export interface UpdateState {
  phase: UpdatePhase;
  /** Version on offer once one is known. */
  version?: string;
  /** Actionable, user-facing text: why an update failed or why applying is blocked. */
  message?: string;
  /** Updates are unavailable in builds without a configured update origin. */
  configured: boolean;
}
export type UpdateAction = 'check' | 'download' | 'apply';
export type RuntimeStatus = 'starting' | 'ready' | 'degraded' | 'stopping' | 'stopped';
