// Core package: shared types, interfaces, and protocol definitions
// Everything in this package is types-only (no runtime behavior)

export type { StateAdapter } from './adapter.js';
export {
  BASH_COMMAND_DISPLAY_MAX_LENGTH,
  HOOK_API_PREFIX,
  HOOK_SCRIPTS_DIR,
  SERVER_JSON_DIR,
  SERVER_JSON_NAME,
  TASK_DESCRIPTION_DISPLAY_MAX_LENGTH,
} from './constants.js';
export type { DesktopMessages, DesktopRequests } from './desktop/requests.js';
export type {
  DesktopAgent,
  DesktopEvent,
  DesktopSeat,
  DesktopSettings,
  DesktopSnapshot,
  EventEnvelope,
  MutationContext,
  OperationState,
  ProviderCapabilities,
  ProviderId,
  RpcError,
  RpcResult,
  RuntimeStatus,
  SessionKey,
  SessionKeyString,
} from './desktop/types.js';
export {
  assertPayloadSize,
  assertPrompt,
  isProviderId,
  isRecord,
  MAX_EVENT_BYTES,
  MAX_PROMPT_LENGTH,
  parseSessionKey,
  validateSeat,
} from './desktop/validation.js';
export type { ClientMessage, FurnitureAssetMessage, ServerMessage } from './messages.js';
export type { AgentEvent, HookProvider } from './provider.js';
export type {
  AgentMeta,
  ColorValue,
  Disposable,
  FloorColor,
  FurnitureCatalogEntry,
  HookEvent,
  OfficeLayout,
  PersistedAgent,
  PlacedFurniture,
  SpriteData,
} from './schemas.js';
export type { TeamProvider } from './teamProvider.js';
