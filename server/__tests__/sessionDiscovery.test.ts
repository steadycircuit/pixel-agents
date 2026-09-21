import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createProviderRegistry } from '../src/providerRegistry.js';
import { claudeProvider, codexProvider } from '../src/providers/index.js';
import { createRuntimeHost } from '../src/runtimeHost.js';
import { discoverSessions, locateTranscript, WRITER_QUIET_MS } from '../src/sessionDiscovery.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const HOUR = 3_600_000;
const pad = 'x'.repeat(4_000);

async function tmp() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pixel-discovery-')));
  roots.push(root);
  return root;
}
async function claudeTranscript(root: string, id: string, cwd: string, ageMs = 2 * HOUR) {
  const dir = path.join(root, '-encoded-project-dir');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  await writeFile(
    file,
    `${JSON.stringify({ type: 'user', sessionId: id, cwd, message: { content: pad } })}\n`,
  );
  const when = new Date(Date.now() - ageMs);
  await utimes(file, when, when);
  return file;
}
async function codexTranscript(root: string, id: string, cwd: string, ageMs = 2 * HOUR) {
  const dir = path.join(root, '2026', '09', '20');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-09-20T10-54-56-${id}.jsonl`);
  await writeFile(
    file,
    `${JSON.stringify({ type: 'session_meta', payload: { id, cwd } })}\n${JSON.stringify({ pad })}\n`,
  );
  const when = new Date(Date.now() - ageMs);
  await utimes(file, when, when);
  return file;
}

describe('discoverSessions', () => {
  it('reads the real cwd from a Claude transcript, not the lossy project directory name', async () => {
    const root = await tmp();
    await claudeTranscript(root, 'c-1', '/work/my project');
    const [record] = discoverSessions(claudeProvider, 'claude', { roots: [root] });
    expect(record).toMatchObject({
      sessionKey: { providerId: 'claude', sessionId: 'c-1' },
      cwd: '/work/my project',
      folderName: 'my project',
      eligible: true,
    });
  });

  it('reads the session id and cwd Codex records in session_meta', async () => {
    const root = await tmp();
    await codexTranscript(root, 'x-9', '/work/codex-proj');
    const [record] = discoverSessions(codexProvider, 'codex', { roots: [root] });
    expect(record).toMatchObject({
      sessionKey: { providerId: 'codex', sessionId: 'x-9' },
      cwd: '/work/codex-proj',
      eligible: true,
    });
  });

  it('marks recently written sessions ineligible with a reason, keeping them listed', async () => {
    const root = await tmp();
    await claudeTranscript(root, 'busy', '/w', WRITER_QUIET_MS / 4);
    const [record] = discoverSessions(claudeProvider, 'claude', { roots: [root] });
    expect(record).toMatchObject({ eligible: false });
    expect(record!.reason).toMatch(/writing/);
  });

  it('marks a session with no recorded working directory as not resumable', async () => {
    const root = await tmp();
    const dir = path.join(root, 'p');
    await mkdir(dir);
    const file = path.join(dir, 'nocwd.jsonl');
    await writeFile(file, `${JSON.stringify({ type: 'user', pad })}\n`);
    const when = new Date(Date.now() - 2 * HOUR);
    await utimes(file, when, when);
    const [record] = discoverSessions(claudeProvider, 'claude', { roots: [root] });
    expect(record).toMatchObject({ eligible: false, cwd: '' });
    expect(record!.reason).toMatch(/working directory/);
  });

  it('skips tiny transcripts and excluded (live) sessions, newest first', async () => {
    const root = await tmp();
    await claudeTranscript(root, 'old', '/w', 5 * HOUR);
    await claudeTranscript(root, 'new', '/w', 2 * HOUR);
    await claudeTranscript(root, 'live', '/w', 3 * HOUR);
    await writeFile(path.join(root, 'tiny.jsonl'), '{}\n');
    const records = discoverSessions(claudeProvider, 'claude', {
      roots: [root],
      exclude: new Set(['live']),
    });
    expect(records.map((r) => r.sessionKey.sessionId)).toEqual(['new', 'old']);
  });

  it('does not follow symlinks out of a transcript root', async () => {
    const root = await tmp();
    const outside = await tmp();
    await claudeTranscript(outside, 'escaped', '/w');
    await symlink(outside, path.join(root, 'link'));
    expect(discoverSessions(claudeProvider, 'claude', { roots: [root] })).toEqual([]);
  });

  it('tolerates missing roots and unreadable directories', async () => {
    expect(discoverSessions(claudeProvider, 'claude', { roots: ['/definitely/not/here'] })).toEqual(
      [],
    );
  });
});

describe('locateTranscript', () => {
  it('finds a Claude transcript by session id and a Codex one by its embedded id', async () => {
    const claudeRoot = await tmp();
    const codexRoot = await tmp();
    const c = await claudeTranscript(claudeRoot, 'claude-id-1', '/w');
    const x = await codexTranscript(codexRoot, '01a0c29c-2335-7ba0-be90-be0c44e4da25', '/w');
    expect(locateTranscript(claudeProvider, 'claude-id-1', [claudeRoot])).toBe(c);
    expect(
      locateTranscript(codexProvider, '01a0c29c-2335-7ba0-be90-be0c44e4da25', [codexRoot]),
    ).toBe(x);
  });

  it('never matches a partial id, never leaves the roots, and rejects path-like ids', async () => {
    const root = await tmp();
    const outside = await tmp();
    await claudeTranscript(root, 'abc-123', '/w');
    const escaped = await claudeTranscript(outside, 'secret', '/w');
    expect(locateTranscript(claudeProvider, 'abc', [root])).toBeUndefined();
    expect(locateTranscript(claudeProvider, '123', [root])).toBeUndefined();
    expect(locateTranscript(claudeProvider, 'secret', [root])).toBeUndefined();
    expect(
      locateTranscript(claudeProvider, `../${path.basename(path.dirname(escaped))}/secret`, [root]),
    ).toBeUndefined();
    expect(locateTranscript(claudeProvider, '', [root])).toBeUndefined();
  });
});

describe('conversation history for a session first seen mid-flight', () => {
  it('finds the transcript itself when hooks never named one', async () => {
    const root = await tmp();
    const claudeRoot = path.join(root, 'claude-projects');
    const dir = path.join(claudeRoot, 'p');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'mid-flight.jsonl'),
      [
        JSON.stringify({ type: 'user', content: 'Hello there' }),
        JSON.stringify({ type: 'assistant', content: [{ type: 'text', text: 'Hi back' }] }),
      ].join('\n'),
    );
    const host = createRuntimeHost({
      profileRoot: path.join(root, 'desktop'),
      hookToken: 't',
      sessionRoots: { claude: [claudeRoot], codex: [] },
      providers: createProviderRegistry([claudeProvider, codexProvider], async () => ({
        executable: process.execPath,
        version: 'test',
      })),
    });
    await host.start();
    try {
      const { port } = host.hookServer.registration()!;
      // A PreToolUse with no transcript_path: the agent is created without one.
      await fetch(`http://127.0.0.1:${port}/api/hooks/claude`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'mid-flight', hook_event_name: 'Stop', cwd: root }),
      });
      const [agent] = host.snapshot().agents;
      expect(agent!.transcriptPath).toBeUndefined();
      const conversation = host.getAgentConversation(agent!.agentId);
      expect(conversation.messages.map((m) => m.text)).toEqual(['Hello there', 'Hi back']);
    } finally {
      await host.stop('test');
    }
  });
});

describe('re-employing a discovered session', () => {
  async function setup() {
    const root = await tmp();
    const cli = path.join(root, 'fake-cli');
    await writeFile(
      cli,
      `#!/bin/sh\n[ "$1" = "--version" ] && echo fake 1.0 && exit 0\necho "$@" >> "${root}/invocations.log"\nsleep 30\n`,
    );
    await chmod(cli, 0o755);
    const claudeRoot = path.join(root, 'claude-projects');
    const workdir = path.join(root, 'work');
    await mkdir(workdir);
    // A dismissal imported from the legacy config: an unqualified tombstone.
    await writeFile(
      path.join(root, 'config.json'),
      JSON.stringify({ dismissedSessionIds: ['resume-me'] }),
    );
    await claudeTranscript(claudeRoot, 'resume-me', workdir);
    await claudeTranscript(claudeRoot, 'busy-one', workdir, 60_000);
    const host = createRuntimeHost({
      profileRoot: path.join(root, 'desktop'),
      hookToken: 't',
      sessionRoots: { claude: [claudeRoot], codex: [] },
      providers: createProviderRegistry([claudeProvider, codexProvider], async () => ({
        executable: cli,
        version: 'fake 1.0',
      })),
    });
    await host.start();
    return { host, root, workdir };
  }

  it('lists sessions from both providers with eligibility', async () => {
    const t = await setup();
    try {
      const sessions = await t.host.listPreviousSessions();
      expect(sessions.map((s) => [s.sessionKey.sessionId, s.eligible])).toEqual([
        ['busy-one', false],
        ['resume-me', true],
      ]);
    } finally {
      await t.host.stop('test');
    }
  });

  it('resumes it with the provider CLI, creates the agent and clears a legacy dismissal', async () => {
    const t = await setup();
    try {
      const statePath = path.join(t.root, 'desktop', 'state.json');
      expect(JSON.parse(await readFile(statePath, 'utf8')).legacyDismissed).toEqual(['resume-me']);
      const operation = await t.host.reEmploySession({
        providerId: 'claude',
        sessionId: 'resume-me',
      });
      expect(operation.state).toBe('running');
      expect(t.host.snapshot().agents.map((a) => a.sessionKey.sessionId)).toEqual(['resume-me']);
      expect(t.host.snapshot().agents[0]).toMatchObject({ cwd: t.workdir, retained: true });
      // Explicit re-employment clears the dismissal, durably.
      const saved = JSON.parse(await readFile(statePath, 'utf8'));
      expect(saved.legacyDismissed).toEqual([]);
      expect(saved.agents).toHaveLength(1);
      // The session is now an agent, so it leaves the roster.
      expect((await t.host.listPreviousSessions()).map((s) => s.sessionKey.sessionId)).toEqual([
        'busy-one',
      ]);
    } finally {
      await t.host.stop('test');
    }
  });

  it('refuses a session another process is writing, and an unknown one', async () => {
    const t = await setup();
    try {
      await expect(
        t.host.reEmploySession({ providerId: 'claude', sessionId: 'busy-one' }),
      ).rejects.toThrow('SESSION_BUSY');
      await expect(
        t.host.reEmploySession({ providerId: 'claude', sessionId: 'nope' }),
      ).rejects.toThrow('NOT_FOUND');
      expect(t.host.snapshot().agents).toEqual([]);
    } finally {
      await t.host.stop('test');
    }
  });

  it('creates nothing when the spawn fails', async () => {
    const t = await setup();
    try {
      await rm(path.join(t.workdir), { recursive: true, force: true });
      await expect(
        t.host.reEmploySession({ providerId: 'claude', sessionId: 'resume-me' }),
      ).rejects.toBeInstanceOf(Error);
      expect(t.host.snapshot().agents).toEqual([]);
    } finally {
      await t.host.stop('test');
    }
  });
});
