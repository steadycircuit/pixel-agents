import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { getAgentDisplayName } from '../src/agentNames.js';
import { createProviderRegistry } from '../src/providerRegistry.js';
import { claudeProvider, codexProvider } from '../src/providers/index.js';
import { createRuntimeHost } from '../src/runtimeHost.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(seedAgents: object[] = []) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pixel-identity-')));
  roots.push(root);
  const desktop = path.join(root, 'desktop');
  if (seedAgents.length) {
    await mkdir(desktop, { recursive: true });
    await writeFile(
      path.join(desktop, 'state.json'),
      JSON.stringify({
        schemaVersion: 1,
        agents: seedAgents,
        seats: {},
        seatsRevision: 0,
        dismissed: [],
      }),
    );
    await writeFile(
      path.join(desktop, 'config.json'),
      JSON.stringify({ schemaVersion: 1, settings: {} }),
    );
    await writeFile(
      path.join(desktop, 'layout.json'),
      JSON.stringify({ schemaVersion: 1, layout: null }),
    );
    await writeFile(path.join(desktop, 'migration.json'), JSON.stringify({ schemaVersion: 1 }));
  }
  const host = createRuntimeHost({
    profileRoot: desktop,
    hookToken: 't',
    providers: createProviderRegistry([claudeProvider, codexProvider], async () => ({
      executable: process.execPath,
      version: 'test',
    })),
  });
  await host.start();
  const { port } = host.hookServer.registration()!;
  const hook = (providerId: string, body: object) =>
    fetch(`http://127.0.0.1:${port}/api/hooks/${providerId}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { host, root, hook };
}

describe('agent folder identity from hooks', () => {
  it('learns the folder from a mid-flight session whose first event is not SessionStart', async () => {
    const t = await setup();
    try {
      await t.hook('claude', {
        session_id: 'mid-flight',
        hook_event_name: 'PreToolUse',
        cwd: '/work/My-Project',
        transcript_path: '/home/x/.claude/projects/p/mid-flight.jsonl',
        tool_name: 'Read',
        tool_input: { file_path: '/work/a.ts' },
      });
      const [agent] = t.host.snapshot().agents;
      expect(agent).toMatchObject({
        cwd: '/work/My-Project',
        transcriptPath: '/home/x/.claude/projects/p/mid-flight.jsonl',
      });
      expect(agent!.displayName).toBe(getAgentDisplayName('mid-flight', 'My-Project'));
      expect(agent!.displayName.endsWith(' Myproject')).toBe(true);
    } finally {
      await t.host.stop('test');
    }
  });

  it('gives different folders different surnames, not one shared "Workspace"', async () => {
    const t = await setup();
    try {
      await t.hook('claude', {
        session_id: 's1',
        hook_event_name: 'SessionStart',
        cwd: '/w/alpha',
      });
      await t.hook('codex', { session_id: 's2', event: 'SessionStart', cwd: '/w/beta' });
      const names = t.host.snapshot().agents.map((a) => a.displayName.split(' ')[1]);
      expect(names).toEqual(['Alpha', 'Beta']);
    } finally {
      await t.host.stop('test');
    }
  });

  it('repairs an agent that was stored without a folder as soon as any event names one', async () => {
    const t = await setup([
      {
        agentId: 1,
        sessionKey: { providerId: 'claude', sessionId: 'stored' },
        cwd: '',
        displayName: getAgentDisplayName('stored', undefined),
        isExternal: true,
        retained: true,
        dismissed: false,
        writerActive: false,
        status: 'working',
        lastActivityAt: 0,
      },
    ]);
    try {
      expect(t.host.snapshot().agents[0]!.displayName.endsWith(' Workspace')).toBe(true);
      await t.hook('claude', { session_id: 'stored', hook_event_name: 'Stop', cwd: '/w/gamma' });
      const agent = t.host.snapshot().agents[0]!;
      expect(agent.cwd).toBe('/w/gamma');
      expect(agent.displayName).toBe(getAgentDisplayName('stored', 'gamma'));
      expect(agent.agentId).toBe(1); // same character, renamed in place
    } finally {
      await t.host.stop('test');
    }
  });

  it('prefers a registered workspace label, and never renames a custom name', async () => {
    const t = await setup();
    try {
      const folder = path.join(t.root, 'some-folder');
      await mkdir(folder);
      await t.host.addWorkspace(folder);
      await t.hook('claude', { session_id: 's', hook_event_name: 'SessionStart', cwd: folder });
      expect(t.host.snapshot().agents[0]!.displayName).toBe(
        getAgentDisplayName('s', 'some-folder'),
      );
    } finally {
      await t.host.stop('test');
    }
  });
});
