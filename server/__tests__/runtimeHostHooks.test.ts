import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

describe('desktop runtime hook coordination', () => {
  it('normalizes both providers into durable, provider-qualified agents and activity', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pixel-runtime-hooks-'));
    roots.push(root);
    const providers = createProviderRegistry(
      [claudeProvider, codexProvider],
      async (providerId) => ({ executable: process.execPath, version: `${providerId} test` }),
    );
    const host = createRuntimeHost({
      profileRoot: path.join(root, 'desktop'),
      hookToken: 'hook-token',
      providers,
    });
    await host.start();
    const transcript = path.join(root, 'session.jsonl');
    await writeFile(
      transcript,
      [
        JSON.stringify({ type: 'user', content: 'Hello', timestamp: '2026-01-01T00:00:00Z' }),
        JSON.stringify({ type: 'assistant', content: [{ type: 'text', text: 'Hi there' }] }),
      ].join('\n'),
    );
    const registration = host.hookServer.registration();
    expect(registration).toBeDefined();
    const post = (providerId: 'claude' | 'codex', payload: Record<string, unknown>) =>
      fetch(`http://127.0.0.1:${registration!.port}/api/hooks/${providerId}`, {
        method: 'POST',
        headers: { Authorization: 'Bearer hook-token', 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

    expect(
      (
        await post('claude', {
          session_id: 'shared-session',
          hook_event_name: 'SessionStart',
          cwd: root,
          transcript_path: transcript,
        })
      ).status,
    ).toBe(202);
    await post('claude', {
      session_id: 'shared-session',
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/example.ts' },
    });
    await post('codex', {
      session_id: 'shared-session',
      event: 'SessionStart',
      cwd: root,
    });

    const agents = host.snapshot().agents;
    expect(agents).toHaveLength(2);
    expect(agents.map((agent) => agent.sessionKey.providerId)).toEqual(['claude', 'codex']);
    expect(agents[0]).toMatchObject({
      status: 'working',
      activity: { tools: [{ toolName: 'Read', status: 'Reading example.ts' }] },
    });
    expect(agents[0].agentId).not.toBe(agents[1].agentId);
    expect(host.getAgentConversation(agents[0].agentId)).toMatchObject({
      sessionKey: { providerId: 'claude', sessionId: 'shared-session' },
      messages: [
        { role: 'user', text: 'Hello' },
        { role: 'assistant', text: 'Hi there' },
      ],
    });
    await host.closeAgent(agents[0].agentId);
    await post('claude', {
      session_id: 'shared-session',
      hook_event_name: 'SessionStart',
      cwd: root,
    });
    expect(host.snapshot().agents).toHaveLength(1);
    await host.stop('test');

    const persisted = JSON.parse(
      await readFile(path.join(root, 'desktop', 'state.json'), 'utf8'),
    ) as { agents: unknown[]; dismissed: string[] };
    expect(persisted.agents).toHaveLength(1);
    expect(persisted.dismissed).toEqual(['claude:shared-session']);
  });
});
