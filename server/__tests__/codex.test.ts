import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { codexProvider, getSessionInfo } from '../src/providers/hook/codex/codex.js';

describe('codexProvider', () => {
  it('exposes the hook provider contract', () => {
    expect(codexProvider.kind).toBe('hook');
    expect(codexProvider.id).toBe('codex');
    expect(codexProvider.displayName).toBe('Codex');
    expect(codexProvider.protocolVersion).toBe(1);
    expect(codexProvider.team).toBeUndefined();
  });

  it('uses the non-interactive resume command for prompts from Field Notes', () => {
    expect(
      codexProvider.buildPromptCommand?.('thread-123', '/workspace/app', 'Continue this'),
    ).toEqual({
      command: 'codex',
      args: ['exec', 'resume', 'thread-123', 'Continue this'],
      env: { PWD: '/workspace/app' },
    });
  });

  it('uses exec mode when launching an agent without a terminal', () => {
    expect(
      codexProvider.buildLaunchCommand?.('thread-123', '/workspace/app', {
        initialPrompt: 'Wait for my next instruction.',
      }),
    ).toEqual({
      command: 'codex',
      args: ['exec', 'Wait for my next instruction.'],
      env: { PWD: '/workspace/app' },
    });
  });

  it('normalizes Codex lifecycle events', () => {
    const start = codexProvider.normalizeHookEvent({
      hook_event_name: 'SessionStart',
      session_id: 'session-1',
      transcript_path: '/tmp/rollout.jsonl',
      cwd: '/workspace',
    });
    expect(start?.event).toEqual({
      kind: 'sessionStart',
      transcriptPath: '/tmp/rollout.jsonl',
      cwd: '/workspace',
      source: undefined,
    });

    expect(
      codexProvider.normalizeHookEvent({
        hook_event_name: 'PermissionRequest',
        session_id: 'session-1',
      })?.event.kind,
    ).toBe('permissionRequest');
    expect(
      codexProvider.normalizeHookEvent({ hook_event_name: 'Stop', session_id: 'session-1' })?.event,
    ).toEqual({ kind: 'turnEnd' });
    expect(
      codexProvider.normalizeHookEvent({ hook_event_name: 'Interrupt', session_id: 'session-1' })
        ?.event,
    ).toEqual({ kind: 'turnEnd', awaitingInput: true });
  });

  it('normalizes tool events with Codex field aliases', () => {
    const result = codexProvider.normalizeHookEvent({
      hook_event_name: 'PreToolUse',
      session_id: 'session-1',
      tool_name: 'shell',
      tool_input: { command: 'npm test' },
      call_id: 'call-1',
    });
    expect(result?.event).toEqual({
      kind: 'toolStart',
      toolId: 'call-1',
      toolName: 'shell',
      input: { command: 'npm test' },
    });

    expect(
      codexProvider.normalizeHookEvent({
        hook_event_name: 'PostToolUse',
        session_id: 'session-1',
        call_id: 'call-1',
      })?.event,
    ).toEqual({ kind: 'toolEnd', toolId: 'call-1' });
    expect(
      codexProvider.normalizeHookEvent({ hook_event_name: 'PostToolUse', session_id: 'session-1' })
        ?.event,
    ).toEqual({ kind: 'toolEnd', toolId: 'current' });
  });

  it('formats common Codex tools and ignores unknown events', () => {
    expect(codexProvider.formatToolStatus('shell', { command: 'npm test' })).toBe(
      'Running: npm test',
    );
    expect(codexProvider.formatToolStatus('read_file', { path: '/workspace/app.ts' })).toBe(
      'Reading app.ts',
    );
    expect(
      codexProvider.normalizeHookEvent({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'session-1',
      }),
    ).toBeNull();
  });

  it('reads the real session id and cwd from a nested Codex transcript', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-codex-'));
    const file = path.join(dir, 'rollout.jsonl');
    writeFileSync(
      file,
      `${JSON.stringify({
        type: 'session_meta',
        payload: { id: 'thread-123', session_id: 'thread-123', cwd: '/workspace/app' },
      })}\n`,
    );
    try {
      expect(getSessionInfo(file)).toEqual({ sessionId: 'thread-123', cwd: '/workspace/app' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
