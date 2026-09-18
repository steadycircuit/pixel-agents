# Codex support plan

Status: **implemented — initial Codex CLI support**
Owner: Steady Circuit  
Scope: Add Codex CLI support while preserving the existing Claude Code provider  
Last reviewed: 2026-09-18

## Goal

Allow Pixel Agents to observe and visualize Codex CLI sessions in the existing
VS Code extension and standalone web UI. A Codex session should appear as an
agent and emit the same normalized lifecycle, tool, permission, waiting,
subagent, and context-usage signals currently consumed by the office UI.

This plan intentionally excludes ChatGPT web/API support. It targets the local
Codex CLI integration surface and its command hooks.

## Progress tracker

Update this table as work lands. Checkboxes are the source of truth for task
progress; the status column records the current phase.

| Phase | Status | Exit criteria |
| --- | --- | --- |
| 0. Baseline and protocol decisions | ✅ Complete | Official hook contract documented and covered by sanitized provider fixtures |
| 1. Provider foundation | ✅ Complete | `codexProvider` implements the provider contract and is registered |
| 2. Codex hook delivery | ✅ Complete | Codex hooks install safely and forward to every live Pixel Agents server |
| 3. Transcript and context support | ◐ Partial | Hook-based session adoption works; transcript format remains intentionally opportunistic |
| 4. Host/provider selection | ✅ Complete | Hosts select Codex with `PIXEL_AGENTS_PROVIDER=codex` |
| 5. UI/settings and packaging | ✅ Complete | Consent, capabilities, docs, and both hook bundles are wired |
| 6. Verification and release | ◐ Automated complete | Build, lint, type checks, unit tests, and package contract pass; manual Codex CLI verification remains |

## Design decisions

- Keep Claude support intact and make Codex an additional provider with ID
  `codex`.
- Reuse the existing normalized `AgentEvent` protocol and `HookProvider`
  interface wherever their semantics fit.
- Use Codex command hooks as the primary live-event source. Codex hooks receive
  JSON on stdin and expose `session_id`, `transcript_path`, `cwd`,
  `hook_event_name`, `model`, and, for turn events, `turn_id`.
- Keep hook installation opt-in and consent-gated. Installation should modify
  `~/.codex/hooks.json` or another supported user-level Codex configuration
  without overwriting unrelated hooks.
- Prefer a user-level hook install for the first implementation so the feature
  works across repositories and does not depend on project trust for
  `.codex/` configuration.
- Do not port Claude Agent Teams assumptions until Codex subagent behavior and
  identifiers are captured from real sessions. Basic subagent support can land
  first; `TeamProvider` remains unset unless the evidence supports it.
- Treat Codex hook payloads and transcripts as untrusted input: validate JSON,
  bound request sizes, redact diagnostics, and fail closed on malformed config.

## Phase 0 — Baseline and protocol decisions

- [x] Confirm the supported Codex CLI hook contract from official OpenAI Docs. The initial implementation targets the documented current lifecycle fields and keeps unknown event fields optional.
- [x] Capture sanitized fixtures in `server/__tests__/codex.test.ts` for:
  - [x] `SessionStart` and `SessionEnd`.
  - [x] `PreToolUse` and `PostToolUse`.
  - [x] `PermissionRequest`.
  - [x] `Stop` and `Interrupt`.
  - [x] `SubagentStart` and `SubagentStop`.
- [ ] Capture the exact tool payload shapes for file reads, edits, writes,
  shell commands, searches, MCP calls, and other common tools.
- [x] Determine how Codex identifies a tool call across `PreToolUse` and
  `PostToolUse`; use `turn_id` or a provider-owned correlation strategy when a
  stable tool ID is absent.
- [x] Determine the supported boundary for transcripts: `transcript_path` is
  accepted for session association, but its record format is not treated as a
  stable hook interface.
- [ ] Determine whether `transcript_path` is always
  present, readable, append-only, and suitable for tail-following.
- [x] Document permission events and map them to Pixel Agents’ permission
  indicator without exposing sensitive hook output.
- [x] Treat `Stop` as done and `Interrupt` as waiting for input in the initial
  provider. Revisit if a future Codex event provides a more precise idle state.
- [x] Decide the first supported Codex subagent behavior: basic lifecycle only;
  no Claude Agent Teams semantics.

Deliverable: `docs/providers/codex.md` containing the sanitized event mapping,
version assumptions, and known gaps.

## Phase 1 — Provider foundation

### New provider files

- [x] Add `server/src/providers/hook/codex/codex.ts`.
- [x] Add `server/src/providers/hook/codex/constants.ts`.
- [x] Add `server/src/providers/hook/codex/consentCopy.ts`.
- [x] Add a Codex hook forwarder at
  `server/src/providers/hook/codex/hooks/codex-hook.ts`.
- [x] Add provider and installer tests under `server/__tests__/`.

### `HookProvider` implementation

- [x] Set `id: 'codex'`, display name, and protocol version 1.
- [x] Implement `normalizeHookEvent()` for the Codex event names and fields.
- [x] Implement `formatToolStatus()` with safe, bounded display strings.
- [x] Define Codex read-like tools for animation and permission-exempt tools
  for timers.
- [x] Define `contextWindowForModel()` with a safe one-million-token estimate;
  unknown model IDs do not fail the provider.
- [x] Implement `buildLaunchCommand()` for `codex`, including cwd and the
  documented bypass-permissions flag.
- [x] Add a conservative `~/.codex/sessions` fallback for existing-session
  scanning; live hook `transcript_path` remains authoritative.
- [x] Leave `team` unset; Codex teams are outside the initial scope.

### Registration

- [x] Export `codexProvider` from `server/src/providers/index.ts`.
- [x] Add it to the provider registry without changing Claude’s default behavior.

## Phase 2 — Codex hook delivery

- [x] Implement the Codex hook forwarder using the existing server registry and
  bearer-token protocol.
- [x] POST to `/api/hooks/codex`, not the Claude endpoint.
- [x] Preserve the current multi-server fan-out behavior for embedded and
  standalone servers.
- [x] Make delivery best-effort and bounded so a stalled Pixel Agents server
  cannot block Codex.
- [x] Install only the required Codex events and use stable command detection to
  identify Pixel Agents entries.
- [x] Merge with unrelated Codex hooks and preserve their content.
- [x] Make install/uninstall idempotent and atomic.
- [x] Refuse to rewrite malformed `~/.codex/hooks.json`.
- [x] Add explicit consent copy describing the file modified, event data sent,
  local destination, and undo behavior.
- [x] Install at user level so project trust is not required.
- [x] Add tests for install, uninstall, third-party hooks, idempotence, and
  malformed JSON.

## Phase 3 — Transcript and context support

- [x] Keep Codex transcript interpretation out of Claude-specific branches and
  use hook events as the authoritative normalized source.
- [ ] Add a Codex transcript parser or provider-owned record parser rather than
  extending Claude-specific branches in `server/src/transcriptParser.ts`.
- [ ] Normalize Codex transcript records into existing runtime events.
- [ ] Support tail-following of a live Codex transcript where available.
- [x] Use the hook’s `transcript_path` to associate a session with its file.
- [ ] Add existing-session discovery for the current workspace.
- [ ] Add global “Watch All Sessions” discovery if Codex has a stable global
  session root.
- [ ] Add context-usage extraction for Codex usage records, with safe handling
  for missing usage and compaction.
- [ ] Ensure partial final lines, truncation, malformed records, and rotated
  transcripts do not crash the watcher.
- [ ] Add tests for session adoption, resume, duplicate discovery, and context
  gauge restoration.

If Codex does not expose enough transcript data for a feature, keep the hook
path functional and mark that feature unavailable instead of inferring Claude
record shapes.

## Phase 4 — Host and provider selection

- [x] Replace direct `claudeProvider` assumptions in
  `adapters/vscode/agentManager.ts` with a selected provider.
- [x] Make terminal name prefixes provider-specific.
- [x] Make runtime construction provider-specific in the VS Code adapter and
  standalone CLI.
- [x] Route launch, session discovery, hook consent, install, uninstall, and
  status through provider lookup.
- [x] Replace hard-coded Claude capability messages with capabilities from the
  active provider.
- [x] Add `PIXEL_AGENTS_PROVIDER=codex` provider selection while preserving the
  current Claude default for existing users.
- [x] Restrict each host process to one active provider so session parsing and
  persisted agent state cannot mix provider schemas.
- [ ] Ensure agents from different providers cannot collide on session IDs,
  transcript paths, or persisted state.
- [x] Decide that the initial runtime watches one provider per process; a future
  multi-provider runtime can remove this boundary once parser state is scoped.
- [ ] Decide whether a single server can watch both providers at once. Prefer
  supporting both if the current runtime can safely register both providers;
  otherwise document the selection boundary and enforce it explicitly.
- [ ] Keep Claude-specific migration and uninstall behavior isolated to Claude.

Likely files to review or refactor:

```text
adapters/vscode/agentManager.ts
adapters/vscode/PixelAgentsViewProvider.ts
adapters/vscode/uninstall.ts
server/src/cli.ts
server/src/agentRuntime.ts
server/src/fileWatcher.ts
server/src/transcriptParser.ts
server/src/clientMessageHandler.ts
server/src/providers/index.ts
```

## Phase 5 — UI, packaging, and documentation

- [x] Show Codex in provider status/consent UI without changing the existing
  Claude settings semantics.
- [x] Make hook status and consent provider-specific.
- [x] Keep webview animations driven by active-provider capabilities, not Claude
  names.
- [x] Update package metadata and requirements from Claude-only wording.
- [x] Include the Codex hook script in the package contract.
- [ ] Update the JSONL viewer or replace its Claude-specific assumptions with a
  provider-aware label/path model.
- [x] Update README setup and provider behavior documentation.
- [x] Add `docs/providers/codex.md` and link it from the README.
- [ ] Add migration notes for users who have existing Claude settings and want
  Codex only.

## Phase 6 — Verification and release

### Automated checks

- [x] Run `npm run check-types`.
- [x] Run `npm run lint` as part of `npm run build`.
- [x] Run `npm test` — 86 webview tests, 557 server tests, and package-contract tests passed.
- [x] Run the Codex provider/unit test suite with sanitized fixtures.
- [ ] Run standalone E2E tests for Codex session discovery, activity, waiting,
  and permissions.
- [ ] Run VS Code E2E tests for Codex launch/adoption and panel rendering.
- [x] Run package contract checks.
- [x] Run the full existing Claude suite to prove no regression.

### Manual checks

- [ ] Start a real Codex session in a clean workspace and verify agent creation.
- [ ] Exercise read, edit, write, shell, search, permission, and idle flows.
- [ ] Restart Pixel Agents while Codex remains active and verify restoration.
- [ ] Run two Pixel Agents servers and verify hook fan-out.
- [x] Install alongside unrelated Codex hooks and confirm they remain intact in
  installer tests.
- [ ] Decline consent and verify no Codex configuration is modified.
- [ ] Uninstall and verify only Pixel Agents entries are removed.
- [x] Confirm the forwarder does not log hook payloads or prompts.

### Release criteria

- [x] Codex support is explicitly selectable with `PIXEL_AGENTS_PROVIDER=codex`.
- [ ] Claude behavior and existing persisted state remain compatible.
- [ ] Malformed or unavailable Codex configuration degrades gracefully.
- [ ] All supported events have fixtures and regression tests.
- [ ] README and provider documentation match the shipped behavior.
- [ ] Version/changelog entry is prepared.

## Suggested implementation order

1. Complete Phase 0 fixtures and event mapping.
2. Implement and test `codexProvider` without changing the UI.
3. Implement the Codex hook forwarder and consent-safe installer.
4. Add transcript/session discovery and context usage.
5. Generalize host selection and launch paths.
6. Add UI, packaging, documentation, and E2E coverage.
7. Run the full Claude regression suite and manual Codex verification.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Codex event payloads evolve | Keep raw-to-normalized conversion isolated and fixture-driven |
| Hook IDs do not correlate cleanly | Use provider-owned correlation state and document any lossy mapping |
| User config is damaged during install | Atomic writes, structural validation, marker-based removal, and refusal on malformed files |
| Codex subagents differ from Claude | Ship basic agents first; do not assume `TeamProvider` semantics |
| Context usage is unavailable | Keep the gauge unknown rather than showing a misleading percentage |
| Multiple providers share a server | Key discovery, persistence, and routing by provider ID/session ID |
| Existing Claude code is accidentally generalized incorrectly | Preserve Claude tests and keep provider-specific parsing in provider modules |

## Open questions to resolve before implementation

- [ ] Which Codex CLI versions are in scope?
- [ ] Is the Codex hook configuration path guaranteed to be `~/.codex/hooks.json`
  for all supported platforms, or should the installer use a documented
  config-discovery strategy?
- [ ] Does Codex expose stable tool-call IDs in both pre- and post-tool events?
- [ ] Which transcript records contain usage and model context information?
- [ ] Can Codex launch a new session with a caller-supplied session ID, or must
  Pixel Agents adopt the generated ID from `SessionStart`?
- [ ] Should Codex hooks be installed automatically after consent, or should
  the first release support only manual/user-configured hooks?
- [ ] Does the current UI need a provider selector, or is Codex-only mode the
  intended initial product behavior?

## Progress log

| Date | Change | Owner |
| --- | --- | --- |
| 2026-09-18 | Initial Codex-only implementation plan created after repository review. Official OpenAI Docs confirm the Codex hook lifecycle and stdin metadata needed for the provider design. | Codex |
| 2026-09-18 | Implemented the Codex provider, hook installer/forwarder, active-provider selection, host wiring, package bundling, docs, tests, and Claude regression fixes. Automated verification and a temporary Codex-mode CLI hook-install smoke test passed; a real agent session remains for manual verification. | Codex |

## Reference material

- [Codex hooks — official OpenAI Docs](https://developers.openai.com/docs/hooks)
- [Codex CLI — official OpenAI Docs](https://developers.openai.com/docs/codex/cli)
- [Codex configuration — official OpenAI Docs](https://developers.openai.com/docs/config-file/config-advanced)
