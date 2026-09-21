import type { RPCSchema } from 'electrobun/main';

import type { DesktopMessages, DesktopRequests } from '../../core/src/desktop/requests.js';

/** Type-only boundary: the Electrobun SDK is intentionally not imported by core. */
export interface DesktopRPCSchema {
  bun: RPCSchema<{ requests: DesktopRequests; messages: Record<string, never> }>;
  webview: RPCSchema<{ requests: Record<string, never>; messages: DesktopMessages }>;
}
