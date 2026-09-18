import { describe, expect, it } from 'vitest';

import { codexProvider } from '../src/providers/hook/codex/codex.js';

describe('codexProvider', () => {
  it('exposes the hook provider contract', () => {
    expect(codexProvider.kind).toBe('hook');
    expect(codexProvider.id).toBe('codex');
    expect(codexProvider.displayName).toBe('Codex');
    expect(codexProvider.protocolVersion).toBe(1);
    expect(codexProvider.team).toBeUndefined();
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
      codexProvider.normalizeHookEvent({ hook_event_name: 'PermissionRequest', session_id: 'session-1' })
        ?.event.kind,
    ).toBe('permissionRequest');
    expect(
      codexProvider.normalizeHookEvent({ hook_event_name: 'Stop', session_id: 'session-1' })?.event,
    ).toEqual({ kind: 'turnEnd' });
    expect(
      codexProvider.normalizeHookEvent({ hook_event_name: 'Interrupt', session_id: 'session-1' })?.event,
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
      codexProvider.normalizeHookEvent({ hook_event_name: 'PostToolUse', session_id: 'session-1' })?.event,
    ).toEqual({ kind: 'toolEnd', toolId: 'current' });
  });

  it('formats common Codex tools and ignores unknown events', () => {
    expect(codexProvider.formatToolStatus('shell', { command: 'npm test' })).toBe('Running: npm test');
    expect(codexProvider.formatToolStatus('read_file', { path: '/workspace/app.ts' })).toBe(
      'Reading app.ts',
    );
    expect(
      codexProvider.normalizeHookEvent({ hook_event_name: 'UserPromptSubmit', session_id: 'session-1' }),
    ).toBeNull();
  });
});
