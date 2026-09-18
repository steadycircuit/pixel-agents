import { CODEX_HOOK_EVENTS } from './constants.js';

export const CONSENT_INSTALL_HEADLINE = 'One more thing: Codex hooks!';

export const CONSENT_DISCLOSURE = [
  `To bring your Codex agents to life in real time, Pixel Agents adds hooks for ${CODEX_HOOK_EVENTS.length} Codex CLI events to ~/.codex/hooks.json. Existing hooks are preserved.`,
  'Codex sends those event payloads — including session, tool, and working-directory metadata — to a Pixel Agents server on this machine. Everything stays local unless you explicitly expose the server with --host.',
  'You can remove the hooks at any time from Settings → Instant Detection (Hooks).',
].join('\n\n');
