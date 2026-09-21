import type {
  AssetChunk,
  AssetId,
  ConsentChoice,
  DesktopAgent,
  DesktopConversation,
  DesktopSeat,
  DesktopSettings,
  DesktopWorkspace,
  EventEnvelope,
  MutationContext,
  OperationState,
  PreviousSessionRecord,
  ProviderId,
  RpcResult,
  SessionKey,
  SessionKeyString,
  UpdateAction,
  UpdateState,
} from './types.js';
/** Electrobun's RPC schema represents each request as params/response data. */
export interface DesktopRequests {
  [method: string]: { params: unknown; response: unknown };
  getBootstrapState: {
    params: { clientId: string; protocolVersion: 1 };
    response: RpcResult<{
      snapshot: unknown;
      epoch: string;
      revision: number;
      subscriptionId: string;
    }>;
  };
  getAssetChunk: {
    params: { catalogVersion: string; assetId: AssetId; chunkIndex: number };
    response: RpcResult<AssetChunk>;
  };
  releaseSubscription: { params: { subscriptionId: string }; response: RpcResult<void> };
  launchAgent: {
    params: MutationContext & {
      providerId: ProviderId;
      workspaceId: string;
      initialPrompt?: string;
      bypassPermissions: boolean;
    };
    response: RpcResult<{ operationId: string }>;
  };
  reEmploySession: {
    params: MutationContext & { sessionKey: SessionKey };
    response: RpcResult<{ operationId: string }>;
  };
  focusAgent: { params: { agentId: number }; response: RpcResult<DesktopAgent> };
  closeAgent: { params: MutationContext & { agentId: number }; response: RpcResult<void> };
  cancelAgentTurn: {
    params: MutationContext & { operationId: string };
    response: RpcResult<OperationState>;
  };
  getOperationStatus: { params: { operationId: string }; response: RpcResult<OperationState> };
  sendAgentPrompt: {
    params: MutationContext & { agentId: number; prompt: string };
    response: RpcResult<{ operationId: string }>;
  };
  getAgentConversation: {
    params: { agentId: number; cursor?: string; limit?: number };
    response: RpcResult<DesktopConversation>;
  };
  selectFolder: {
    params: { clientId: string; purpose: 'workspace' };
    response: RpcResult<{ selectionId: string; path: string } | null>;
  };
  addWorkspace: {
    params: MutationContext & { selectionId: string };
    response: RpcResult<DesktopWorkspace>;
  };
  removeWorkspace: {
    params: MutationContext & { workspaceId: string };
    response: RpcResult<void>;
  };
  saveLayout: {
    params: MutationContext & { layout: unknown; expectedLayoutRevision: number };
    response: RpcResult<{ layoutRevision: number }>;
  };
  saveAgentSeats: {
    params: MutationContext & {
      seats: Record<SessionKeyString, DesktopSeat>;
      expectedSeatsRevision: number;
    };
    response: RpcResult<{ seatsRevision: number }>;
  };
  setSetting: {
    params: MutationContext & { key: keyof DesktopSettings; value: boolean | string };
    response: RpcResult<DesktopSettings>;
  };
  getUpdateState: { params: Record<string, never>; response: RpcResult<UpdateState> };
  runUpdateAction: {
    params: { action: UpdateAction; epoch: string };
    response: RpcResult<UpdateState>;
  };
  listPreviousSessions: {
    params: { clientId: string };
    response: RpcResult<PreviousSessionRecord[]>;
  };
  answerHooksConsent: {
    params: MutationContext & { providerId: ProviderId; choice: ConsentChoice };
    response: RpcResult<void>;
  };
  setHooksEnabled: {
    params: MutationContext & { providerId: ProviderId; enabled: boolean };
    response: RpcResult<unknown>;
  };
}
export interface DesktopMessages {
  [name: string]: unknown;
  event: EventEnvelope;
}
