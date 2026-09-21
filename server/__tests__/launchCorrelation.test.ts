import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createProviderRegistry } from '../src/providerRegistry.js';
import { claudeProvider, codexProvider } from '../src/providers/index.js';
import { createRuntimeHost } from '../src/runtimeHost.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pixel-correlate-')));
  roots.push(root);
  const cli = path.join(root, 'fake-cli');
  await writeFile(cli, '#!/bin/sh\n[ "$1" = "--version" ] && echo fake 1.0 && exit 0\nsleep 30\n');
  await chmod(cli, 0o755);
  const host = createRuntimeHost({
    profileRoot: path.join(root, 'desktop'),
    hookToken: 't',
    providers: createProviderRegistry([claudeProvider, codexProvider], async () => ({
      executable: cli,
      version: 'fake 1.0',
    })),
  });
  await host.start();
  const folderA = path.join(root, 'a');
  const folderB = path.join(root, 'b');
  await mkdir(folderA);
  await mkdir(folderB);
  const wa = await host.addWorkspace(folderA);
  const wb = await host.addWorkspace(folderB);
  const { port } = host.hookServer.registration()!;
  const hook = (providerId: string, body: object) =>
    fetch(`http://127.0.0.1:${port}/api/hooks/${providerId}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { host, folderA, folderB, wa, wb, hook };
}

describe('provider launch correlation', () => {
  it('a Claude launch is identified up front by the session id it was given', async () => {
    const t = await setup();
    try {
      const operation = await t.host.launchAgent('claude', t.wa.id);
      expect(operation.sessionKey).toMatchObject({ providerId: 'claude' });
    } finally {
      await t.host.stop('test');
    }
  });

  it('a Codex launch is not given a made-up session id; its own SessionStart binds it', async () => {
    const t = await setup();
    try {
      const operation = await t.host.launchAgent('codex', t.wa.id);
      expect(operation.sessionKey).toBeUndefined();

      await t.hook('codex', { session_id: 'codex-real-id', event: 'SessionStart', cwd: t.folderA });
      const bound = t.host.operationStatus(operation.operationId);
      expect(bound?.sessionKey).toEqual({ providerId: 'codex', sessionId: 'codex-real-id' });

      // While the owned turn runs, that session cannot be dismissed out from under it.
      const agent = t.host
        .snapshot()
        .agents.find((a) => a.sessionKey.sessionId === 'codex-real-id');
      expect(agent).toBeDefined();
      await expect(t.host.closeAgent(agent!.agentId)).rejects.toThrow('SESSION_BUSY');
    } finally {
      await t.host.stop('test');
    }
  });

  it('serializes launches per provider and folder, but not across folders or providers', async () => {
    const t = await setup();
    try {
      await t.host.launchAgent('codex', t.wa.id);
      await expect(t.host.launchAgent('codex', t.wa.id)).rejects.toThrow('SESSION_BUSY');
      await expect(t.host.launchAgent('codex', t.wb.id)).resolves.toBeDefined();
      await expect(t.host.launchAgent('claude', t.wa.id)).resolves.toBeDefined();
    } finally {
      await t.host.stop('test');
    }
  });

  it('never attaches a session from another folder to a launch', async () => {
    const t = await setup();
    try {
      const operation = await t.host.launchAgent('codex', t.wa.id);
      await t.hook('codex', { session_id: 'elsewhere', event: 'SessionStart', cwd: t.folderB });
      expect(t.host.operationStatus(operation.operationId)?.sessionKey).toBeUndefined();
      // ...and it is still a normal external agent.
      expect(t.host.snapshot().agents.map((a) => a.sessionKey.sessionId)).toContain('elsewhere');
    } finally {
      await t.host.stop('test');
    }
  });

  it('two launches in different folders each bind only their own session', async () => {
    const t = await setup();
    try {
      const a = await t.host.launchAgent('codex', t.wa.id);
      const b = await t.host.launchAgent('codex', t.wb.id);
      await t.hook('codex', { session_id: 'for-b', event: 'SessionStart', cwd: t.folderB });
      await t.hook('codex', { session_id: 'for-a', event: 'SessionStart', cwd: t.folderA });
      expect(t.host.operationStatus(a.operationId)?.sessionKey?.sessionId).toBe('for-a');
      expect(t.host.operationStatus(b.operationId)?.sessionKey?.sessionId).toBe('for-b');
    } finally {
      await t.host.stop('test');
    }
  });

  it('a cancelled launch (killed by signal) stops blocking dismissal of its session', async () => {
    const t = await setup();
    try {
      const operation = await t.host.launchAgent('claude', t.wa.id);
      const { sessionId } = operation.sessionKey!;
      await t.hook('claude', {
        session_id: sessionId,
        hook_event_name: 'SessionStart',
        cwd: t.folderA,
      });
      const agent = t.host.snapshot().agents.find((a) => a.sessionKey.sessionId === sessionId)!;
      await expect(t.host.closeAgent(agent.agentId)).rejects.toThrow('SESSION_BUSY');
      t.host.cancelOperation(operation.operationId);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await expect(t.host.closeAgent(agent.agentId)).resolves.toBeUndefined();
    } finally {
      await t.host.stop('test');
    }
  });

  it('a session that was already known is never re-bound to a later launch', async () => {
    const t = await setup();
    try {
      await t.hook('codex', { session_id: 'old', event: 'SessionStart', cwd: t.folderA });
      const operation = await t.host.launchAgent('codex', t.wa.id);
      await t.hook('codex', { session_id: 'old', event: 'SessionStart', cwd: t.folderA });
      expect(t.host.operationStatus(operation.operationId)?.sessionKey).toBeUndefined();
    } finally {
      await t.host.stop('test');
    }
  });
});
