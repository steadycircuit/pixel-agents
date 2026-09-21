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

/** Default handler settings: fire-and-forget, so a slow desktop app never delays Codex. */
export const CODEX_HOOK_TIMEOUT_SECONDS = 5;
/**
 * Codex caps some events at 3 seconds and does not support `async` on SessionEnd; it warns on every
 * start ("clamping SessionEnd hook timeout to 3s", "running async SessionEnd hook synchronously")
 * and applies those limits anyway. Declaring them here keeps the definition honest and the
 * warnings away.
 */
export const CODEX_HOOK_LIMITS: Partial<
  Record<(typeof CODEX_HOOK_EVENTS)[number], { timeout: number; async: boolean }>
> = {
  SessionEnd: { timeout: 3, async: false },
  Interrupt: { timeout: 3, async: true },
};

export const CODEX_HOOK_CONFIG_DIR = '.codex';
export const CODEX_HOOK_CONFIG_NAME = 'hooks.json';
export const CODEX_TERMINAL_NAME_PREFIX = 'Codex';
export const CODEX_CONTEXT_WINDOW = 1_000_000;
export const CODEX_SETTINGS_FRESH_FILE_MODE = 0o600;
export const CODEX_SETTINGS_TMP_SUFFIX = '.pixel-agents-tmp';
