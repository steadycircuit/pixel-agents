/** Codex-specific integration constants. */

export const CODEX_HOOK_SCRIPT_NAME = 'codex-hook.js';
export const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'Stop',
  'Interrupt',
  'PermissionRequest',
  'PreToolUse',
  'PostToolUse',
  'SubagentStart',
  'SubagentStop',
] as const;

export const CODEX_HOOK_CONFIG_DIR = '.codex';
export const CODEX_HOOK_CONFIG_NAME = 'hooks.json';
export const CODEX_TERMINAL_NAME_PREFIX = 'Codex';
export const CODEX_CONTEXT_WINDOW = 1_000_000;
export const CODEX_SETTINGS_FRESH_FILE_MODE = 0o600;
export const CODEX_SETTINGS_TMP_SUFFIX = '.pixel-agents-tmp';
