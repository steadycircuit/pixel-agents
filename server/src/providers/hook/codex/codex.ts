import * as os from 'os';
import * as path from 'path';

import type { AgentEvent, HookProvider } from '../../../../../core/src/provider.js';
import { BASH_COMMAND_DISPLAY_MAX_LENGTH, TASK_DESCRIPTION_DISPLAY_MAX_LENGTH } from '../../../constants.js';
import { areHooksInstalled, copyHookScript, installHooks, uninstallHooks } from './codexHookInstaller.js';
import { CONSENT_DISCLOSURE, CONSENT_INSTALL_HEADLINE } from './consentCopy.js';
import { CODEX_CONTEXT_WINDOW, CODEX_TERMINAL_NAME_PREFIX } from './constants.js';

function recordString(raw: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) if (typeof raw[key] === 'string') return raw[key] as string;
  return undefined;
}

function recordObject(raw: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  for (const key of keys) {
    const value = raw[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  }
  return {};
}

function toolId(raw: Record<string, unknown>, fallback: string): string {
  return recordString(raw, 'tool_call_id', 'call_id', 'tool_id', 'id') ?? fallback;
}

export function formatToolStatus(toolName: string, input?: unknown): string {
  const value = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const basename = (item: unknown) => (typeof item === 'string' ? path.basename(item) : '');
  const command = typeof value.command === 'string' ? value.command : '';
  const description = typeof value.description === 'string' ? value.description : '';
  if (/read|cat|view/i.test(toolName)) return `Reading ${basename(value.file_path ?? value.path)}`;
  if (/edit|write|patch/i.test(toolName)) return `Editing ${basename(value.file_path ?? value.path)}`;
  if (/shell|bash|exec|command/i.test(toolName)) return `Running: ${command.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH)}${command.length > BASH_COMMAND_DISPLAY_MAX_LENGTH ? '…' : ''}`;
  if (/search|grep|glob|find/i.test(toolName)) return 'Searching files';
  if (/agent|subagent/i.test(toolName)) return description ? `Subtask: ${description.slice(0, TASK_DESCRIPTION_DISPLAY_MAX_LENGTH)}${description.length > TASK_DESCRIPTION_DISPLAY_MAX_LENGTH ? '…' : ''}` : 'Running subtask';
  return `Using ${toolName || 'tool'}`;
}

function normalizeHookEvent(raw: Record<string, unknown>): { sessionId: string; event: AgentEvent } | null {
  const sessionId = recordString(raw, 'session_id', 'sessionId');
  const eventName = recordString(raw, 'hook_event_name', 'event');
  if (!sessionId || !eventName) return null;
  const id = toolId(raw, `hook-${recordString(raw, 'turn_id') ?? Date.now()}`);
  switch (eventName) {
    case 'SessionStart':
      return { sessionId, event: { kind: 'sessionStart', transcriptPath: recordString(raw, 'transcript_path'), cwd: recordString(raw, 'cwd'), source: recordString(raw, 'source') } };
    case 'SessionEnd':
      return { sessionId, event: { kind: 'sessionEnd', reason: recordString(raw, 'reason') } };
    case 'PreToolUse': {
      const toolName = recordString(raw, 'tool_name', 'toolName', 'name') ?? 'tool';
      const input = recordObject(raw, 'tool_input', 'toolInput', 'input');
      return { sessionId, event: { kind: 'toolStart', toolId: id, toolName, input } };
    }
    case 'PostToolUse':
      return {
        sessionId,
        event: {
          kind: 'toolEnd',
          toolId: recordString(raw, 'tool_call_id', 'call_id', 'tool_id', 'id') ? id : 'current',
        },
      };
    case 'PermissionRequest':
      return { sessionId, event: { kind: 'permissionRequest' } };
    case 'Stop':
      return { sessionId, event: { kind: 'turnEnd' } };
    case 'Interrupt':
      return { sessionId, event: { kind: 'turnEnd', awaitingInput: true } };
    case 'SubagentStart':
      return { sessionId, event: { kind: 'subagentStart', parentToolId: 'current', toolId: id, toolName: recordString(raw, 'agent_type', 'agent_name', 'name') ?? 'subagent', input: raw } };
    case 'SubagentStop':
      return { sessionId, event: { kind: 'subagentEnd', parentToolId: 'current', toolId: 'current' } };
    default:
      return null;
  }
}

function getSessionDirs(_workspacePath: string): string[] {
  // Codex transcript paths are intentionally not treated as a stable public
  // interface. Hooks provide the authoritative live session association.
  return [path.join(os.homedir(), '.codex', 'sessions')];
}

function getAllSessionRoots(): string[] {
  return [path.join(os.homedir(), '.codex', 'sessions')];
}

function buildLaunchCommand(_sessionId: string, cwd: string, opts?: { bypassPermissions?: boolean }) {
  const args = opts?.bypassPermissions ? ['--dangerously-bypass-approvals-and-sandbox'] : [];
  return { command: 'codex', args, env: { PWD: cwd } };
}

export function contextWindowForModel(_model: string | undefined): number {
  return CODEX_CONTEXT_WINDOW;
}

export const codexProvider: HookProvider = {
  kind: 'hook',
  id: 'codex',
  displayName: 'Codex',
  protocolVersion: 1,
  normalizeHookEvent,
  installHooks: async () => installHooks(),
  uninstallHooks: async () => uninstallHooks(),
  areHooksInstalled: async () => areHooksInstalled(),
  consentDisclosure: () => ({ headline: CONSENT_INSTALL_HEADLINE, disclosure: CONSENT_DISCLOSURE }),
  formatToolStatus,
  permissionExemptTools: new Set(['read', 'search', 'grep', 'glob']),
  subagentToolNames: new Set(['spawn_agent', 'agent', 'subagent']),
  readingTools: new Set(['read', 'search', 'grep', 'glob', 'list_dir']),
  terminalNamePrefix: CODEX_TERMINAL_NAME_PREFIX,
  contextWindowForModel,
  getSessionDirs,
  getAllSessionRoots,
  sessionFilePattern: '*.jsonl',
  buildLaunchCommand,
};

export { copyHookScript };
