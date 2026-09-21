import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHookServer } from '../src/hookServer.js';

const servers: Array<ReturnType<typeof createHookServer>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

describe('desktop hook server', () => {
  it('accepts authenticated, normalized provider hooks and exposes only a minimal health response', async () => {
    const onHookEvent = vi.fn();
    const server = createHookServer({ token: 'test-token', onHookEvent, onFocus: vi.fn() });
    servers.push(server);
    const { port } = await server.start();
    const base = `http://127.0.0.1:${port}`;

    expect(await (await fetch(`${base}/api/health`)).json()).toEqual({ status: 'ok' });
    expect(
      (
        await fetch(`${base}/api/hooks/claude`, {
          method: 'POST',
          headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: 'session-1', hook_event_name: 'Stop' }),
        })
      ).status,
    ).toBe(202);
    expect(onHookEvent).toHaveBeenCalledWith('claude', {
      session_id: 'session-1',
      hook_event_name: 'Stop',
    });
  });

  it('rejects unauthenticated, browser-originated, unknown, malformed, and oversized requests', async () => {
    const server = createHookServer({
      token: 'test-token',
      onHookEvent: vi.fn(),
      onFocus: vi.fn(),
    });
    servers.push(server);
    const { port } = await server.start();
    const base = `http://127.0.0.1:${port}`;
    const post = (path: string, init: RequestInit = {}) =>
      fetch(`${base}${path}`, { method: 'POST', ...init });

    expect((await post('/api/hooks/claude')).status).toBe(401);
    expect(
      (
        await post('/api/hooks/claude', {
          headers: {
            Authorization: 'Bearer test-token',
            Origin: 'https://example.test',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ session_id: 'one', hook_event_name: 'Stop' }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post('/api/hooks/unknown', {
          headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: 'one', hook_event_name: 'Stop' }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await post('/api/hooks/codex', {
          headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: 'Stop' }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post('/api/hooks/codex', {
          headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: 'one', event: 'Stop', padding: 'x'.repeat(70_000) }),
        })
      ).status,
    ).toBe(413);
  });

  it('requires bearer authentication for the fixed focus action', async () => {
    const onFocus = vi.fn();
    const server = createHookServer({ token: 'test-token', onHookEvent: vi.fn(), onFocus });
    servers.push(server);
    const { port } = await server.start();
    const base = `http://127.0.0.1:${port}`;
    expect((await fetch(`${base}/api/desktop/focus`, { method: 'POST' })).status).toBe(401);
    expect(
      (
        await fetch(`${base}/api/desktop/focus`, {
          method: 'POST',
          headers: { Authorization: 'Bearer test-token' },
        })
      ).status,
    ).toBe(204);
    expect(onFocus).toHaveBeenCalledOnce();
  });
});
