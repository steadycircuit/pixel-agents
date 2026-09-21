import { randomBytes, timingSafeEqual } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';

import { HOOK_API_PREFIX } from '../../core/src/constants.js';
import { MAX_HOOK_BODY_SIZE } from './constants.js';

export type DesktopHookProviderId = 'claude' | 'codex';
export interface HookServerRegistration {
  /** Loopback port. This is published only to the local hook helper. */
  port: number;
  /** Per-start bearer token. Never include this in renderer state or logs. */
  token: string;
}
export interface HookServerOptions {
  token?: string;
  instanceId?: string;
  onHookEvent(
    providerId: DesktopHookProviderId,
    event: Record<string, unknown>,
  ): void | Promise<void>;
  onFocus(): void | Promise<void>;
}
export interface HookServer {
  start(): Promise<HookServerRegistration>;
  stop(): Promise<void>;
  registration(): HookServerRegistration | undefined;
}

const hookProviders = new Set<DesktopHookProviderId>(['claude', 'codex']);

/**
 * Private ingress for provider hook helpers. It intentionally has no UI,
 * websocket, CORS, or general-purpose control surface.
 */
export function createHookServer(options: HookServerOptions): HookServer {
  const token = options.token ?? randomBytes(32).toString('base64url');
  let app: FastifyInstance | undefined;
  let active: HookServerRegistration | undefined;
  let startPromise: Promise<HookServerRegistration> | undefined;
  let stopPromise: Promise<void> | undefined;

  return {
    async start() {
      if (active) return active;
      if (startPromise) return startPromise;
      startPromise = (async () => {
        const instance = Fastify({
          logger: false,
          bodyLimit: MAX_HOOK_BODY_SIZE,
          requestTimeout: 5_000,
        });
        instance.addHook('onRequest', async (request, reply) => {
          if (!isLoopbackHost(request.headers.host)) {
            await reply.code(400).send({ error: 'invalid host' });
            return;
          }
          // Helpers do not send Origin. Any browser-originated request is rejected
          // even if a malicious page can reach a loopback address.
          if (request.headers.origin) {
            await reply.code(400).send({ error: 'browser origins are not accepted' });
          }
        });
        instance.setErrorHandler((error, _request, reply) => {
          if ((error as { statusCode?: number }).statusCode === 413) {
            void reply.code(413).send({ error: 'payload too large' });
            return;
          }
          void reply.code(400).send({ error: 'invalid request' });
        });
        instance.get('/api/health', async (request) => ({
          status: 'ok',
          ...(options.instanceId &&
          constantTimeEqual(request.headers.authorization ?? '', `Bearer ${token}`)
            ? { instanceId: options.instanceId }
            : {}),
        }));
        instance.post<{ Params: { providerId: string }; Body: unknown }>(
          `${HOOK_API_PREFIX}/:providerId`,
          { preHandler: requireBearer(token) },
          async (request, reply) => {
            if (!hookProviders.has(request.params.providerId as DesktopHookProviderId)) {
              return reply.code(404).send({ error: 'unknown provider' });
            }
            if (!isJson(request) || !isHookPayload(request.body)) {
              return reply.code(400).send({ error: 'invalid hook payload' });
            }
            await options.onHookEvent(
              request.params.providerId as DesktopHookProviderId,
              request.body,
            );
            return reply.code(202).send({ status: 'accepted' });
          },
        );
        instance.post(
          '/api/desktop/focus',
          { preHandler: requireBearer(token) },
          async (_request, reply) => {
            await options.onFocus();
            return reply.code(204).send();
          },
        );
        try {
          await instance.listen({ host: '127.0.0.1', port: 0 });
          const address = instance.server.address();
          if (!address || typeof address === 'string')
            throw new Error('Hook server did not bind a TCP port');
          app = instance;
          active = { port: address.port, token };
          return active;
        } catch (error) {
          await instance.close();
          throw error;
        }
      })();
      try {
        return await startPromise;
      } finally {
        startPromise = undefined;
      }
    },
    async stop() {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        const instance = app;
        app = undefined;
        active = undefined;
        if (instance) await instance.close();
      })();
      return stopPromise;
    },
    registration: () => active,
  };
}

function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const hostname = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':', 1)[0];
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

function isJson(request: FastifyRequest): boolean {
  return (
    request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
  );
}

function isHookPayload(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  const sessionId = payload['session_id'] ?? payload['sessionId'];
  const eventName = payload['hook_event_name'] ?? payload['event'];
  return (
    typeof sessionId === 'string' &&
    sessionId.length > 0 &&
    typeof eventName === 'string' &&
    eventName.length > 0
  );
}

function requireBearer(token: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!constantTimeEqual(request.headers.authorization ?? '', `Bearer ${token}`)) {
      await reply.code(401).send({ error: 'unauthorized' });
    }
  };
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
