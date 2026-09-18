# Codex support plan

Status: **planned**  
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
| 0. Baseline and protocol decisions | ☐ Not started | Codex event fixtures and mappings are documented |
| 1. Provider foundation | ☐ Not started | `codexProvider` implements the provider contract and is registered |
| 2. Codex hook delivery | ☐ Not started | Codex hooks reliably POST normalized events to every live Pixel Agents server |
| 3. Transcript and context support | ☐ Not started | Existing/resumed Codex sessions can be discovered and show activity/context |
| 4. Host/provider selection | ☐ Not started | VS Code and standalone paths launch or adopt Codex without Claude coupling |
| 5. UI/settings and packaging | ☐ Not started | Provider status, consent, capabilities, docs, and package contents work |
| 6. Verification and release | ☐ Not started | Unit, integration, E2E, package, and manual checks pass |

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

- [ ] Confirm the supported Codex CLI versions and minimum hook behavior.
- [ ] Capture sanitized fixtures for:
  - [ ] `SessionStart` and `SessionEnd`.
  - [ ] `PreToolUse` and `PostToolUse`.
  - [ ] `PermissionRequest`.
  - [ ] `UserPromptSubmit`, `Stop`, and `Interrupt`.
  - [ ] `SubagentStart` and `SubagentStop`, if available in the installed CLI.
- [ ] Capture the exact tool payload shapes for file reads, edits, writes,
  shell commands, searches, MCP calls, and other common tools.
- [ ] Determine how Codex identifies a tool call across `PreToolUse` and
  `PostToolUse`; use `turn_id` or a provider-owned correlation strategy when a
  stable tool ID is absent.
- [ ] Determine the transcript format and whether `transcript_path` is always
  present, readable, append-only, and suitable for tail-following.
- [ ] Document permission modes and map them to Pixel Agents’ permission
  indicator without exposing sensitive hook output.
- [ ] Decide whether `Stop` always means “done” or whether Codex has a distinct
  idle/waiting signal. Record any ambiguity in fixtures and tests.
- [ ] Decide the first supported Codex subagent behavior and explicitly mark
  unsupported team semantics.

Deliverable: `docs/providers/codex.md` containing the sanitized event mapping,
version assumptions, and known gaps.

## Phase 1 — Provider foundation

### New provider files

- [ ] Add `server/src/providers/hook/codex/codex.ts`.
- [ ] Add `server/src/providers/hook/codex/constants.ts`.
- [ ] Add `server/src/providers/hook/codex/consentCopy.ts`.
- [ ] Add a Codex hook forwarder, likely
  `server/src/providers/hook/codex/hooks/codex-hook.ts`.
- [ ] Add provider unit tests under `server/__tests__/`.

### `HookProvider` implementation

- [ ] Set `id: 'codex'`, display name, and the current protocol version.
- [ ] Implement `normalizeHookEvent()` for the Codex event names and fields.
- [ ] Normalize tool start/end, permission, session lifecycle, turn end, and
  subagent events into `AgentEvent`.
- [ ] Implement `formatToolStatus()` with safe, bounded display strings.
- [ ] Define Codex read-like tools for animation and permission-exempt tools
  for timers.
- [ ] Define `contextWindowForModel()` using the model IDs observed in Codex
  transcripts; unknown models must remain safe and non-fatal.
- [ ] Implement `buildLaunchCommand()` for `codex`, including session/cwd
  handling that can be adopted by the VS Code terminal manager.
- [ ] Implement Codex session roots and file patterns only after Phase 0 has
  confirmed the on-disk layout.
- [ ] Leave `team` unset initially unless Codex team metadata is verified.

### Registration

- [ ] Export `codexProvider` from `server/src/providers/index.ts`.
- [ ] Add it to `hookProviders` without changing Claude’s default behavior.
- [ ] Add provider-specific constants instead of importing Claude constants in
  shared code.

## Phase 2 — Codex hook delivery

- [ ] Implement the Codex hook forwarder using the existing server registry and
  bearer-token protocol.
- [ ] POST to `/api/hooks/codex`, not the Claude endpoint.
- [ ] Preserve the current multi-server fan-out behavior for embedded and
  standalone servers.
- [ ] Make delivery best-effort and bounded so a stalled Pixel Agents server
  cannot block Codex.
- [ ] Install only the required Codex events and use stable marker detection to
  identify Pixel Agents entries.
- [ ] Merge with unrelated Codex hooks and preserve their ordering/content.
- [ ] Make install/uninstall idempotent and race-safe.
- [ ] Refuse to rewrite malformed `~/.codex/hooks.json` or configuration files.
- [ ] Add explicit consent copy describing the file modified, event data sent,
  local destination, and undo behavior.
- [ ] Ensure hook installation works when the Codex project is not trusted by
  using the supported user-level configuration path.
- [ ] Add tests for install, uninstall, partial install, malformed JSON,
  third-party hooks, duplicate entries, and multi-server delivery.

## Phase 3 — Transcript and context support

- [ ] Add a Codex transcript parser or provider-owned record parser rather than
  extending Claude-specific branches in `server/src/transcriptParser.ts`.
- [ ] Normalize Codex transcript records into existing runtime events.
- [ ] Support tail-following of a live Codex transcript where available.
- [ ] Use the hook’s `transcript_path` to associate a session with its file.
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

- [ ] Replace direct `claudeProvider` assumptions in
  `adapters/vscode/agentManager.ts` with a selected provider.
- [ ] Make terminal name prefixes provider-specific.
- [ ] Make runtime construction provider-specific in the VS Code adapter and
  standalone CLI.
- [ ] Route launch, session discovery, hook consent, install, uninstall, and
  status through provider lookup.
- [ ] Replace hard-coded Claude capability messages with capabilities from the
  active provider.
- [ ] Add a provider setting or launch choice for Codex while preserving the
  current Claude default for existing users.
- [ ] Ensure agents from different providers cannot collide on session IDs,
  transcript paths, or persisted state.
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

- [ ] Show Codex in provider status/consent UI without changing the existing
  Claude settings semantics.
- [ ] Make the settings display provider-specific hook state where necessary.
- [ ] Keep webview animations driven by provider capabilities, not Claude tool
  names.
- [ ] Update `core/asyncapi.yaml` and regenerate message types only if the
  wire protocol needs a new provider field.
- [ ] Update package metadata and requirements from Claude-only wording.
- [ ] Include the Codex hook script in the package contract when applicable.
- [ ] Update the JSONL viewer or replace its Claude-specific assumptions with a
  provider-aware label/path model.
- [ ] Update README setup, consent, troubleshooting, and security sections.
- [ ] Add `docs/providers/codex.md` and link it from the README.
- [ ] Add migration notes for users who have existing Claude settings and want
  Codex only.

## Phase 6 — Verification and release

### Automated checks

- [ ] Run `npm run check-types`.
- [ ] Run `npm run lint`.
- [ ] Run `npm test`.
- [ ] Run the Codex provider/unit test suite with sanitized fixtures.
- [ ] Run standalone E2E tests for session discovery, activity, waiting, and
  permissions.
- [ ] Run VS Code E2E tests for Codex launch/adoption and panel rendering.
- [ ] Run package contract and package verification checks.
- [ ] Run the full existing Claude suite to prove no regression.

### Manual checks

- [ ] Start a Codex session in a clean workspace and verify agent creation.
- [ ] Exercise read, edit, write, shell, search, permission, and idle flows.
- [ ] Restart Pixel Agents while Codex remains active and verify restoration.
- [ ] Run two Pixel Agents servers and verify hook fan-out.
- [ ] Install alongside unrelated Codex hooks and confirm they remain intact.
- [ ] Decline consent and verify no Codex configuration is modified.
- [ ] Uninstall and verify only Pixel Agents entries are removed.
- [ ] Confirm secrets and full prompts are not written to normal logs.

### Release criteria

- [ ] Codex support is opt-in or explicitly selectable.
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

## Reference material

- [Codex hooks — official OpenAI Docs](https://developers.openai.com/docs/hooks)
- [Codex CLI — official OpenAI Docs](https://developers.openai.com/docs/codex/cli)
- [Codex configuration — official OpenAI Docs](https://developers.openai.com/docs/config-file/config-advanced)

