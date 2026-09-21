import type { ServerMessage } from '../../../core/src/messages.js';
import { isBrowserRuntime, isDesktopRuntime, isE2E } from '../runtime.js';
import { DesktopTransport } from './desktopTransport.js';
import { PostMessageTransport } from './postMessageTransport.js';
import type { MessageTransport } from './types.js';
import { WebSocketTransport } from './webSocketTransport.js';

function createTransport(): MessageTransport {
  if (isDesktopRuntime) return new DesktopTransport();
  if (!isBrowserRuntime) {
    return new PostMessageTransport();
  }
  // Standalone browser: connect via WebSocket to the same host serving the SPA.
  // The server token rides the handshake query when this page was opened from
  // the tokened URL the CLI printed — that is what makes the session privileged
  // enough to approve a hook install (server/src/httpServer.ts). Without it the
  // socket still connects and the office still renders; only the hooks toggle
  // is refused. WebSocketTransport captures the url once, so the token survives
  // reconnects even if the address bar is later cleared.
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = new URLSearchParams(window.location.search).get('token');
  const wsUrl = `${protocol}//${window.location.host}/ws${
    token ? `?token=${encodeURIComponent(token)}` : ''
  }`;
  const ws = new WebSocketTransport(wsUrl);
  ws.connect();
  // Vite dev only: there is no server to connect to, so `browserMock` injects
  // ServerMessages as `window` 'message' events. Bridge them into the transport
  // (the WebSocket never opens against the dev server). Guarded by DEV so it's
  // tree-shaken out of the production standalone build.
  if (import.meta.env.DEV) {
    window.addEventListener('message', (e: MessageEvent) => {
      const data = e.data as unknown;
      if (
        data &&
        typeof data === 'object' &&
        typeof (data as { type?: unknown }).type === 'string'
      ) {
        ws.deliver(data as ServerMessage);
      }
    });
  }
  return ws;
}

/** Singleton transport instance. Import this everywhere instead of vscodeApi. */
export const transport: MessageTransport = createTransport();

// Test builds only (the e2e flag is injected by the harness): lets the packaged-app smoke run
// drive the real transport. Never present in a user's session.
if (isE2E) (window.__pixelAgentsTestHooks ??= {}).transport = transport;
export type { MessageTransport } from './types.js';
