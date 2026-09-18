/**
 * Provider registry: re-exports all bundled providers.
 *
 * Adding a new CLI provider:
 *   1. Create `server/src/providers/hook/<cli>/<cli>.ts` implementing HookProvider.
 *      (File-based and stream-based provider types will land when the first such
 *       provider ships.)
 *   2. Add an export line below.
 *
 * The adapter (VS Code extension, standalone CLI, etc.) imports from here rather
 * than reaching into each provider directory directly.
 */

import type { HookProvider } from '../../../core/src/provider.js';
import { claudeProvider } from './hook/claude/claude.js';
import { codexProvider,copyHookScript as copyCodexHookScript } from './hook/codex/codex.js';

export { claudeProvider };
export { codexProvider, copyCodexHookScript };
export { copyHookScript } from './hook/claude/claudeHookInstaller.js';

/**
 * Select the provider for a host process. Existing Claude users retain the
 * historical default; Codex users can run the extension/CLI with
 * PIXEL_AGENTS_PROVIDER=codex. Keeping one active provider per process matches
 * the runtime's single transcript parser and prevents cross-provider hooks
 * from being interpreted with the wrong schema.
 */
export const activeProvider: HookProvider =
  process.env['PIXEL_AGENTS_PROVIDER']?.toLowerCase() === 'codex' ? codexProvider : claudeProvider;

/** The active provider is the only provider whose hooks are installed and
 * surfaced in the current host process. */
export const hookProviders: readonly HookProvider[] = [activeProvider];

/** Resolve a wire-supplied provider id, or undefined for an unknown one —
 *  the caller writes nothing on undefined (fail-closed, like a junk choice). */
export function hookProviderById(id: unknown): HookProvider | undefined {
  return typeof id === 'string' ? hookProviders.find((p) => p.id === id) : undefined;
}
