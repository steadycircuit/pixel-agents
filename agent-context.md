# Pixel Agents — Agent Context

> Durable, compact reference for working in this repo without re-researching.
> Canonical glossary lives in `CONTEXT.md`; the consent decision rationale in
> `docs/adr/0001-*.md`. This file captures **how the code fits together, where
> things live, the invariants that are easy to break, and how to build/test it.**
> Verify anything load-bearing against the current tree before relying on it.

## 1. What this project is

A pixel-art office where AI coding agents (Claude Code today; Codex added) become
animated characters. One source tree ships **two artifacts**:

- **VS Code extension** `pablodelucca.pixel-agents` (Marketplace + Open VSX) — bundles
  VS Code adapter + webview SPA + assets + hook scripts.
- **npm package** `pixel-agents` — `npx pixel-agents` runs a Fastify server that serves
  the same SPA (standalone "browser" mode) and receives provider hook POSTs.

Two **providers** are supported concurrently in code: **Claude Code** (reference
implementation, full teams/subagents) and **Codex** (newer; see §8, §10). Provider
selection is per-process via the `PIXEL_AGENTS_PROVIDER` env var.

Repo: `https://github.com/pixel-agents-hq/pixel-agents`. License: MIT. Node 22 (`.nvmrc`).
**npm workspaces** monorepo (`server`, `webview-ui`) — a single root `npm install`
installs everything; do not `cd` into a workspace to install.

## 2. How to build, test, lint (the commands that matter)

Run from the **repo root** unless noted.

```bash
npm install                 # root + all workspaces in one shot
npm run compile             # asyncapi:generate → check-types → lint → esbuild → vite
npm run build               # alias for compile
npm run package             # production build (esbuild --production)

npm test                    # = test:webview + test:server + test:package-contract
npm run test:server         # server vitest
npm run test:webview        # webview vitest
npm run lint                # core + server + adapters + webview
npm run check-types         # tsc strict across all packages (+ server test tsconfig)
npm run asyncapi:validate   # validate core/asyncapi.yaml
npm run asyncapi:generate   # regen core/src/messages.ts  ← MUST produce no git diff
npm run e2e:inventory       # regen e2e/README.md         ← MUST produce no git diff
npm run e2e                 # Playwright (real VS Code + standalone)
npm run test:package-contract && npm run verify:npm-package   # npm tarball gate
npm run format:check        # prettier check (prettier runs via lint-staged on commit)
npm run watch               # parallel esbuild watch + tsc watch (NOT the Vite dev server)
cd webview-ui && npm run dev   # Vite dev server — run separately, ~http://localhost:5173
```

**CI drift checks are the load-bearing guarantees** (a non-empty diff fails the build):
`core/asyncapi.yaml` ↔ `core/src/messages.ts` stay in lockstep, and `e2e/README.md`
stays in sync with the spec list. After adding a wire message or an e2e test, run the
matching `:*:generate`/`e2e:inventory` and commit the regenerated output.

`claude-hook.test.ts` needs `dist/hooks/claude-hook.js` — build first (`npm test` builds).

## 3. Architecture & strict layering

Dependencies are one-directional. **Never** import `adapters/vscode/` from the
standalone path, or `server/` from `webview-ui/`.

```
core/            types + interfaces, ZERO runtime side effects (everything is types-only
                 except constants + the asset pipeline). Depends on nothing.
server/          lifecycle runtime + Fastify HTTP/WS. Depends only on core/.
adapters/vscode/ VS Code surface: terminal lifecycle + webview bridge. Depends on core + server.
webview-ui/      React 19 + Canvas UI. Depends only on core/.
```

Both surfaces (VS Code `PixelAgentsViewProvider` and standalone `server/src/cli.ts`)
compose the **same `AgentRuntime`**; only the `StateAdapter` namespace, `MessageTransport`,
and `TerminalAdapter` differ. The protocol shape is identical; only the wire differs.

### Directory map (what lives where)

```
core/
  asyncapi.yaml          AsyncAPI 3.0 contract — SINGLE SOURCE OF TRUTH for the wire protocol
  src/
    messages.ts          AUTO-GENERATED unions (DO NOT EDIT) — 33 ServerMessage + 24 ClientMessage
    schemas.ts           PersistedAgent, AgentMeta, OfficeLayout, PlacedFurniture, SpriteData, ...
    provider.ts          HookProvider + AgentEvent (the integration boundary)
    teamProvider.ts      Optional TeamProvider (Lead + Teammates)
    transport.ts         MessageTransport interface + TransportState
    adapter.ts           StateAdapter (persistence seam), PersistedAgent, AgentSeat
    terminalAdapter.ts   TerminalAdapter (editor-driven terminal mgmt)
    assets/              build.ts, loader.ts, colorUtils.ts, pngDecoder.ts, constants.ts, ...
    constants.ts, normalizeProjectPath.ts, paletteUtils.ts, index.ts

server/
  src/
    agentRuntime.ts      Lifecycle core: timers, scanners, HookEventHandler, SessionRouter, DismissalTracker
    agentStateStore.ts   EventEmitter-backed single source of truth (typed mutations + events)
    sessionRouter.ts     session_id → agent_id, event buffering, pending external sessions
    dismissalTracker.ts  unified dismissal state
    hookEventHandler.ts  dispatches normalized AgentEvent into the runtime
    transcriptParser.ts  JSONL parsing for heuristic/file-fallback mode
    fileWatcher.ts       hybrid fs.watch + polling, JSONL line buffering, /clear detection
    timerManager.ts      waiting / permission timers
    contextUsage.ts      context gauge computation
    agentActivityResend.ts, agentDiagnostics.ts, paletteAssigner.ts, subagentWatch.ts, teamUtils.ts
    httpServer.ts        Fastify: POST /api/hooks/:providerId, /api/health, /ws, SPA (standalone)
    clientMessageHandler.ts   single dispatch point for ClientMessage
    server.ts            top-level composition
    cli.ts               npx pixel-agents entry (npm bin)
    serverConfig.ts, configPersistence.ts, fileStateAdapter.ts, layoutPersistence.ts
    types.ts             AgentState (per-agent runtime data)
    constants.ts         all timing/scanning constants
    providers/index.ts   Provider registry (claudeProvider + hookProviders list)
    providers/hook/
      claude/            claude.ts, claudeTeamProvider.ts, claudeHookInstaller.ts, consentCopy.ts,
                         constants.ts, hooks/claude-hook.ts
      codex/             codex.ts, codexHookInstaller.ts, consentCopy.ts, constants.ts, hooks/codex-hook.ts
      consentGate.ts     WHEN to ask + choice→action rule (consentActionFor)
      consentExecutor.ts provider-agnostic execution + per-process serialization
  __tests__/             33 vitest files (see §12)
  manual-hook-events.http  REST-Client helper to drive the local hook server

adapters/vscode/
  extension.ts           activate()/deactivate()
  PixelAgentsViewProvider.ts  WebviewViewProvider, thin bridge to AgentRuntime
  agentManager.ts        terminal lifecycle (claude --session-id <uuid>), restore, persist
  vscodeTerminalAdapter.ts   TerminalAdapter impl
  uninstall.ts           vscode:uninstall — removes hook entries + factory-resets hooks config
  migrateVsCodeState.ts  one-time legacy state migration (verify-before-clear)
  constants.ts           VS Code IDs, command names, workspace state keys

webview-ui/
  src/
    App.tsx              composition root
    transport/           index.ts (createTransport — the ONLY branching point), postMessage, webSocket
    runtime.ts, browserMock.ts, testHooks.ts, notificationSound.ts, changelogData.ts, constants.ts
    hooks/               useExtensionMessages.ts (THE key file), useEditorActions, useEditorKeyboard,
                         introTourState.ts (pure reducer), useIntroTour.ts
    components/          BottomToolbar, ZoomControls, SettingsModal, InfoModal, DebugView,
                         ConversationDrawer.tsx (new), ui/*
    office/
      engine/            officeState.ts (world), characters.ts (FSM), gameLoop.ts, renderer.ts,
                         matrixEffect*.ts, existingAgents.ts
      editor/            editorActions.ts (pure), editorState.ts, EditorToolbar.tsx
      layout/            furnitureCatalog.ts, layoutSerializer.ts, tileMap.ts
      components/        OfficeCanvas.tsx, ToolOverlay.tsx
      sprites/           spriteData.ts, spriteCache.ts
      types.ts, toolUtils.ts, projection.ts, colorize.ts, floorTiles.ts, wallTiles.ts
  public/assets/         sprites, furniture-catalog.json, default-layout*.json, fonts
  test/                  10 vitest files (see §12)

e2e/                     Playwright: fixtures/, helpers/, tests/{claude/hooks-on,claude/hooks-off,standalone}
scripts/                 generate-messages.ts, run-e2e.mjs, build-allure-report.mjs, asset pipeline
esbuild.js               builds dist/extension.js, dist/cli.js, dist/hooks/*, dist/uninstall.js
docs/adr/0001-*.md       consent choice semantics (the ADR)
```

## 4. The wire protocol

- **`core/asyncapi.yaml`** is the contract, pinned to **AsyncAPI 3.0.0** (Modelina 5.10.1 only
  supports 3.0.0; 3.1.0 yields `export type Root = any`). Both unions use `oneOf` with
  `discriminator: type`; every concrete message sets `additionalProperties: false`.
- **`core/src/messages.ts`** is generated by `scripts/generate-messages.ts` via
  `@asyncapi/modelina` (custom constraints preserve `type`/`status` field names). It carries an
  auto-generation banner. **Regenerate with `npm run asyncapi:generate`; never hand-edit.**

  Counts reflect the **current working tree** (the committed `CLAUDE.md` cites the older
  27/18; the in-progress §10 work added four more).

- **33 ServerMessage** (server→client): providerCapabilities, agentCreated, agentClosed,
  agentSelected, existingAgents, agentStatus, agentToolStart/Done/Clear/Permission/PermissionClear,
  subagentToolStart/Done/Clear/Permission, agentTeamInfo, agentContextUsage, layoutLoaded,
  furnitureAssetsLoaded, characterSpritesLoaded, petSpritesLoaded, floorTilesLoaded,
  wallTilesLoaded, carpetTilesLoaded, settingsLoaded, hooksStatus, hooksConsentRequest,
  externalAssetDirectoriesUpdated, areaMappingsLoaded, workspaceFolders,
  **previousSessions** §10, agentDiagnostics, **agentConversation** §10.
- **24 ClientMessage** (client→server): webviewReady, launchAgent, focusAgent, closeAgent,
  saveAgentSeats, saveLayout, setSoundEnabled, setLastSeenVersion, setAlwaysShowLabels,
  setGhostHeadlessAgents, setHooksEnabled, hooksConsentResponse, setHooksInfoShown,
  setWatchAllSessions, exportLayout, importLayout, openSessionsFolder,
  addExternalAssetDirectory, removeExternalAssetDirectory, saveAreaMappings, setShowAreas,
  requestDiagnostics, **requestAgentConversation** §10, **sendAgentPrompt** §10.

### Transport (one interface, two wires)

`MessageTransport` (`core/src/transport.ts`): `send`, `onMessage`, `ready`, `state`,
`onStateChange`, `dispose`. States: `connecting | connected | reconnecting | disconnected`.

- **PostMessageTransport** (VS Code): `acquireVsCodeApi()`, permanently `connected`.
- **WebSocketTransport** (standalone): reconnects with exponential backoff (250ms→4s cap),
  queues sends while disconnected.
- **`createTransport()` in `webview-ui/src/transport/index.ts` is the ONLY branching point.**
  Everything downstream uses the interface and never knows which transport is active.

## 5. Provider abstraction — the integration boundary

`HookProvider` (`core/src/provider.ts`) is where a CLI-specific integration plugs in.
**Adding a new CLI is one subdirectory** under `server/src/providers/hook/<id>/` (provider +
optional TeamProvider + hook installer + hook script). Zero changes to the runtime, UI, or
existing providers. Register it in `server/src/providers/index.ts`.

**`AgentEvent.kind`** — the canonical, CLI-agnostic event the runtime dispatches on
(never on raw CLI tool names):
`toolStart` · `toolEnd` · `turnEnd` · `subagentStart` · `subagentEnd` · `subagentTurnEnd` ·
`progress` · `permissionRequest` · `sessionStart` · `sessionEnd`.

**`HookProvider` members:**

- **Required**: `kind:'hook'`, `id`, `displayName`, `installCommand`, `docsUrl`,
  `protocolVersion`, `normalizeHookEvent(raw)` → `{sessionId, event} | null`, `installHooks`,
  `uninstallHooks`, `areHooksInstalled`, `consentDisclosure()`, `formatToolStatus`,
  `permissionExemptTools`, `subagentToolNames`, `readingTools` (all three are `ReadonlySet<string>`).
- **Optional**: `terminalNamePrefix`, `contextWindowForModel(model)`.
- **Optional file fallback (heuristic mode)**: `getSessionDirs?`, `getAllSessionRoots?`,
  `getSessionInfo?`, `isSessionActive?`, `sessionFilePattern?`, `parseTranscriptLine?`,
  `buildLaunchCommand?(sessionId, cwd, {bypassPermissions?, initialPrompt?})`,
  `buildPromptCommand?(sessionId, cwd, prompt)` (the last two are the in-progress §10 additions).
- **Optional team extension**: `team?: TeamProvider` (Claude Agent Teams today; empty for
  single-agent CLIs).

**`TeamProvider`** (`core/src/teamProvider.ts`) — semantic queries for Lead + Teammates:
`discoverTeammates`, `getTeamMembers`, `getTeamMetadataForSession`, `extractTeammateNameFromEvent`,
`isTeammateSpawnCall`. Providers choose their own storage strategy; Claude reads
`~/.claude/teams/<name>/config.json`.

### The two providers

- **Claude Code** (reference) — `server/src/providers/hook/claude/claude.ts`.
  `normalizeHookEvent` handles the full set of Claude hook events (snake_case payloads).
  Supports teams, sub-agents, background agents up to Claude Code v2.1.x (Task-era
  `agent_progress`, explicit/implicit teams, background-by-default Agent spawns).
  `contextWindowForModel`: 1M for the current line, 200k for Haiku/older, `undefined`
  for ids it can't place.
- **Codex** — `server/src/providers/hook/codex/codex.ts`. Newer; see §8 for specifics and
  the in-progress work that keeps extending it.

## 6. Agent runtime & activity detection

`AgentRuntime` (`server/src/agentRuntime.ts`) is the shared lifecycle core. Constructor opts:
`store` (AgentStateStore), `providerRegistry`, `layoutPersistence`, `assetCache`,
`config` (`hooksEnabled`, `watchAllSessions`), `terminalAdapter?`, `callbacks`
(RuntimeLifecycleCallbacks — the only seam between runtime and host). Exposes:
`registerAgent` / `unregisterAgent` / `removeAgent` / `removeTeammate(s)`,
`restoreExternalAgents`, `handleHookEvent`, `startProjectScan`, `startExternalScanning`,
`startStaleCheck`, `dispose()`.

Owns timer Maps (waiting, permission, text-idle, stale) and three scanners:
**project-dir 1 s** (terminal adoption), **external 3 s** (global session discovery),
**stale 30 s**. Scanners are skipped entirely while hooks are flowing (the `hookDelivered`
flag is set per agent).

- **`AgentStateStore`** (`agentStateStore.ts`) — EventEmitter-backed single source of truth.
  Typed mutations, typed events (`agentAdded`, `agentRemoved`, `agentUpdated`, `broadcast`).
  The broadcast layer subscribes once at boot and translates `StoreEvents` → `ServerMessage`.
  **No module under `server/` calls a transport method directly.**
- **`SessionRouter`** — `session_id → agent_id` mapping, pre-registration event buffering,
  pending external sessions.
- **`DismissalTracker`** — unified dismissal state (replaced four legacy globals).
  `server/src/types.ts` `AgentState` carries per-agent runtime data (provider ref, session
  key, transcript-fallback `jsonlFile`/`fileOffset`/`lineBuffer`, tool state Maps/Sets, team
  fields, context usage, the `hookDelivered` flag, and `isGlobalSession` — an in-progress §10
  addition for globally-scanned sessions removed when inactive).

### Dual-mode activity detection

| Mode                     | Source                                         | Notes                                                                                                                                                             |
| ------------------------ | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hooks** (preferred)    | CLI hooks API → HTTP POST → `HookEventHandler` | Instant, reliable. `UserPromptSubmit`/`TaskCreated` deliberately NOT installed (normalize to null); `normalizeHookEvent` still tolerates them for stale installs. |
| **Heuristic** (fallback) | Polling JSONL transcripts                      | 500 ms JSONL poll for tool content + `/clear` detection; 1 s project scanner; 3 s external; 30 s stale.                                                           |

JSONL transcripts: `~/.claude/projects/<project-hash>/<session-id>.jsonl`; project hash =
workspace path with `:`/`\`/`/` → `-`. Record types: `assistant` (tool_use/thinking),
`user` (tool_result/text), `system` `subtype:"turn_duration"` (reliable turn-end),
`progress` `data.type` (`agent_progress`/`bash_progress`/`mcp_progress`). `content` can be a
string or an array — handle both. **`/clear` creates a NEW JSONL file** (old one just stops).
`hookDelivered` (per agent) + `hooksEnabled` (global) gate the timers; JSONL polling always
runs for tool content. Only permission (7 s) and text-idle (5 s) timers are suppressed by
`hookDelivered`.

**Context gauge** (`contextUsage.ts`): a **snapshot, not a total** = newest turn's
`input + cache_creation_input + cache_read + output` tokens, against a **provider-declared
window** (`contextWindowForModel`). All-zero usage = "no news" (must not blank the gauge).
**Sidechain rule**: once a file emits a main-chain turn (`sawMainChainUsage`), later sidechain
records belong to a sub-agent. `seedContextUsage` runs once per agent in `startFileWatching`.
Sub-agents get no gauge.

### Teams & sub-agents (the subtle part — see CONTEXT.md for the vocabulary)

Four teammate modes: basic sub-agent (teams OFF), inline teammate (teams ON, in-process),
session teammate (teams + tmux), implicit-team agent (Claude 5, background-by-default).
**Sub-agent vs Teammate distinction = the sidecar `name`** (named → seated Teammate with its
own character + `isTeamLead` on the spawner; unnamed → Sub-agent sub-character near the
parent). Unnamed background spawns are watched in a **shadow `AgentStateStore`**
(`subagentWatch.ts`, ids ≥ 1,000,000) whose broadcasts are translated onto the main store as
`subagentToolStart/Done/Permission` keyed `(leadId, spawnToolUseId)`.

**Critical gate** (the one that bit them): in `webview-ui/src/hooks/useExtensionMessages.ts`,
`agentToolStart` with `runInBackground=true` Agent tools are gated out of sub-character creation
when the parent has a `teamName` (teammate path handles it). With no `teamName`, the gate must
be bypassed so the basic Subtask sub-character still renders. `addSubagent` dedups via
`subagentIdMap`. **`subagentToolStart` creates the sub lazily when missing** (teamed leads'
unnamed background spawns + post-reload recreation).

**Subtle timing (test budget)**: the heuristic permission bubble lands 7 s after the **sub-tool**
is registered, not the parent Task tool. A test waiting on it from the "Subtask:" overlay needs
≥ `1 s (Task→sub-tool gap) + 7 s timer + ~300 ms IPC/render` ≈ **9–10 s**.

## 7. Persistence & config

Everything lives under `~/.pixel-agents/`:

```
~/.pixel-agents/
  config.json              { vscode, standalone, externalAssetDirectories,
                             hooksConsent:{providerId:'granted'|'declined'},
                             hooksEnabled:{providerId:boolean} }   ← per-provider, machine-global
  vscode-state.json        { agents, seats }   (VS Code namespace)
  standalone-state.json    { agents, seats }   (standalone namespace)
  layout.json              OfficeLayout (SHARED across surfaces) — atomic tmp+rename
  server.json              { port, pid, authToken }   ← discovery record
  servers/*.json           multi-instance discovery records
  hooks/claude-hook.js     bundled hook script (CJS, shebang)
```

- **`FileStateAdapter({ namespace })`** backs both runtimes; per-namespace settings
  (`soundEnabled`, `lastSeenVersion`, `alwaysShowLabels`, `watchAllSessions`, `hooksInfoShown`).
  Running both surfaces in parallel never clobbers either. `hooksEnabled` is the durable
  per-provider preference (top-level in config); the `hooksConsent` tri-state is the
  provenance marker for the ADR-0001 revision semantics.
- **`layoutPersistence.ts`** — atomic writes (tmp + rename); cross-window watching is hybrid
  (`fs.watch` + 2 s polling); `markOwnWrite()` prevents the watcher re-reading our own write.
- **`migrateVsCodeState`** (VS Code adapter only) — walks each legacy key once with
  **verify-before-clear** (write to file → read back → only then clear).

### Consent (ADR-0001 — read `docs/adr/0001-*.md`)

Consent is **per-human per-provider**; every consent-bearing wire message carries a `providerId`
the client only echoes. The ask is one step of the **Intro** (four-step first-run tour a Greeter
speaks, `IntroBubble.tsx`), sent during the `webviewReady` handshake, privileged connections only.

- **A choice is an absolute state command, not an event.** Back re-opens the ask; a revision
  undoes whatever the earlier answer left (hooks on disk, a failed-install grant, or a decline's
  own persisted hooks-off). That is why the consent record is a **tri-state** and each answer
  commits in **ONE config write**.
- `consentActionFor(choice, {installed, consent})` in `consentGate.ts` decides;
  `consentExecutor.ts` performs and **serializes answers per process** (a revision can observe
  the first answer mid-flight).
- **Hooks-off is persisted only AFTER a successful uninstall** — persisting it first strands the
  user (entries keep firing while the preference makes the next start skip the gate).
- **Hook identity is anchored at both ends**, case-insensitive: the `/.pixel-agents/hooks/
claude-hook.js` suffix ending the command's FIRST token. Symlinks are deliberately NOT
  recognized.
- **Never rewrite a shape we did not author**: unparseable files, non-array `hooks.<Event>`,
  junk entries are all refused/passed-through, never replaced. Internal sentinels use `Symbol`,
  never a value user JSON could hold.

## 8. Codex provider — specifics & in-progress work

Codex is the second provider (`server/src/providers/hook/codex/`). Key differences from the
Claude reference and the in-progress §10 additions that keep extending it:

- **`normalizeHookEvent`** in `codex.ts` normalizes Codex's payloads (camelCase-ish, different
  event names) into the same `AgentEvent` set.
- **Session identity**: Claude re-uses the supplied UUID as its session id; **Codex does not** —
  `exec <prompt>` lets the provider assign the real id, so a supplied UUID is not authoritative.
  Launch/reply correlation must not assume the id round-trips.
- **Command shapes** (provider `buildLaunchCommand`/`buildPromptCommand`):
  - Claude new: `--print --session-id <id> <prompt>` · reply: `--resume <id> --print <prompt>`
  - Codex new: `exec <prompt>` · reply/resume: `exec resume <id> <prompt>`
- **`buildPromptCommand`** and **`buildLaunchCommand({initialPrompt})`** were added to the
  `HookProvider` interface in the in-progress work (see §10) so the conversation drawer (§10)
  can continue a session with a user prompt for both providers.
- **`getSessionInfo` / `isSessionActive`** (in-progress §10) let the runtime read provider
  metadata from a transcript and detect an active writer — used by previous-sessions re-employment.
- Tests: `server/__tests__/codex.test.ts` (normalizeHookEvent + file fallback),
  `codexHookInstaller.test.ts` (install/uninstall of Codex hooks).
- Docs: `docs/providers/codex.md`.

**Provider selection** is per-process via the `PIXEL_AGENTS_PROVIDER` env var (read in
`server/src/providers/index.ts`). `protocolVersion` gates dispatch — the server refuses events
from a provider whose version it doesn't understand.

## 9. Office UI (webview) & asset system

**Rendering model**: game state lives in an imperative **`OfficeState`** class
(`webview-ui/src/office/engine/officeState.ts`), NOT React state. Pixel-perfect:
zoom = integer device-pixels-per-sprite-pixel (1×–10×), **no `ctx.scale(dpr)`**; default
zoom = `Math.round(2 * devicePixelRatio)`. All entities z-sorted by Y. Camera follow via
`cameraFollowId` (separate from `selectedAgentId`).

**Characters** (`characters.ts`): FSM states — **active** (pathfind to seat, typing/reading
animation by tool type) and **idle** (wander with BFS, return to seat). 4-directional sprites,
left = flipped right. Tool animations: typing (Write/Edit/Bash/Task) vs reading
(Read/Grep/Glob/WebFetch). Chair z-sorting: non-back chairs use `zY=(row+1)*TILE_SIZE`;
back-facing `+1` so the chair back renders in front. Chair tiles blocked except the character's
own seat (per-character pathfinding via `withOwnSeatUnblocked`).

**Palette assignment** (`paletteAssigner.ts`, `pickDiversePalette()`): counts palettes of
current non-sub-agent characters, picks from the least-used. First 6 agents each get a unique
skin (palette 0–5); beyond 6, skins repeat with a random **hue shift** (45–315°) via
`adjustSprite()`. Character stores `palette` + `hueShift`; sprite cache keyed `"palette:hueShift"`.

**Sub-agents** in the UI: negative IDs (from −1 down); created on `agentToolStart` with a
"Subtask:" prefix or lazily by `subagentToolStart` when missing. Same palette+hueShift as the
parent. Spawn at the closest free walkable tile to the parent (`closestFreeWalkableTile`) —
around it, never in a seat. Click focuses the parent's terminal. Never persisted.

**Spawn/despawn**: matrix-style digital rain (0.3 s), 16 columns. `matrixEffect` on Character
(`'spawn'|'despawn'|null`); restored agents use `skipSpawnEffect: true`.

**Speech bubbles**: permission ("…" amber) stays until resolved; waiting (green checkmark)
auto-fades 2 s. **Sound**: ascending two-note chime (E5→E6) via Web Audio API on waiting;
`unlockAudio()` on canvas mousedown.

**Seats**: derived from chair furniture — `layoutToSeats()` creates a seat at every footprint
tile of every chair. Multi-tile chairs → seats keyed `uid`/`uid:1`/`uid:2`. Facing priority:
chair `orientation` → adjacent desk → forward (DOWN).

### Layout editor

Tools: SELECT, Floor paint, Wall paint, Erase (→ `TileType.VOID`), Furniture place, Furniture
pick (eyedropper), Eyedropper (floor). **Floor**: 7 patterns from `floors.png`, colorizable via
HSBC sliders (Photoshop Colorize), color baked per-tile. **Walls**: auto-tile 4-bit bitmask
(N=1,E=2,S=4,W=8), HSBC apply to all wall tiles. **Furniture**: ghost preview (green/red);
**R** rotate, **T** toggle on/off; per-item HSBC color in `PlacedFurniture.color?`.
**Undo/redo**: 50-level, Ctrl+Z/Y. **Multi-stage Esc** exits pick → deselect catalog → close
tool tab → deselect → close editor. **Grid expansion**: ghost border 1 tile outside;
`expandLayout()` grows by 1 tile; max `MAX_COLS×MAX_ROWS` (64×64), default 20×11.

**Layout model** (`core/src/schemas.ts` `OfficeLayout`):
`{ version, cols, rows, tiles:number[], furniture:PlacedFurniture[], tileColors?:FloorColor[] }`.
Persisted debounced → `~/.pixel-agents/layout.json`.

### Asset pipeline

- **Bundle**: `esbuild.js` copies `webview-ui/public/assets/` → `dist/assets/`. In dev, the
  Vite `browserMockAssetsPlugin` (`vite.config.ts`) serves `furniture-catalog.json`,
  `asset-index.json`, and **pre-decoded** sprite JSON sidecars (characters/floors/walls/carpets/
  furniture) — eliminating browser-side PNG decoding. `core/src/assets/build.ts` builds the
  catalog & index; `loader.ts` decodes PNG → `SpriteData`.
- **`SpriteData`** = 2D array of hex strings (`''` transparent, `#RRGGBB`, `#RRGGBBAA`).
  pngjs RGBA, alpha threshold 2 (`PNG_ALPHA_THRESHOLD`).
- **Catalog**: `furniture-catalog.json` — `id, name, label, category, footprint, isDesk,
canPlaceOnWalls, groupId?, orientation?, state?, canPlaceOnSurfaces?, backgroundTiles?`.
  **Rotation groups** (assets sharing `groupId`, 2+ orientations), **state groups**
  (on/off pairs), **auto-state** (electronics swap to ON when an active agent faces a nearby
  desk), **background tiles** (top N rows walkable + placeable-over), **surface placement**
  (laptops/mugs overlap `isDesk`), **wall placement** (paintings/windows on wall tiles).
- **Character sprites**: `char_0.png`–`char_5.png`, each 112×96 (7 frames × 16 px, 3 direction
  rows × 32 px). Row 0=down, 1=up, 2=right. Frame order: walk1,walk2,walk3,type1,type2,read1,
  read2.
- **Default layout**: `core/src/assets/build.ts` picks the highest-numbered
  `default-layout-N.json`; the working tree currently contains `default-layout-2.json`.
- **Load order** (message sequence): `characterSpritesLoaded` → `floorTilesLoaded` →
  `wallTilesLoaded` → `furnitureAssetsLoaded` → `layoutLoaded`.

### UI styling & enforced rules

Pixel-art aesthetic: sharp corners (`borderRadius: 0`), solid backgrounds, `2px solid` borders,
hard offset shadows (`2px 2px 0px`, no blur). CSS vars in `index.css` `:root`
(`--pixel-bg`, `--pixel-border`, `--pixel-accent`, `--pixel-shadow`, …). Font: **FS Pixel Sans**
(`webview-ui/src/fonts/`, `@font-face`).

**Custom ESLint rules** (`eslint-rules/pixel-agents-rules.mjs`, all `error`-level, block PRs):
`no-inline-colors` (hex/rgb/hsl literals only in `constants.ts`), `pixel-shadow` (must use
`var(--pixel-shadow)` or `2px 2px 0px`), `pixel-font` (must reference FS Pixel Sans).

## 10. In-progress (UNCOMMITTED) work in the working tree

> These changes are **not yet committed** and the migration plan itself is **not started**.
> Do not assume they pass tests or are complete. The feature set is coherent and interlocking:

1. **Conversation drawer** (view agent chat history + reply):
   - `server/src/conversation.ts` (new): `readConversation(file, maxMessages=80)` reads a JSONL
     transcript into `{role:'user'|'assistant', text, timestamp?}[]`; `textFromContent` handles
     string and array-of-blocks `content`.
   - `webview-ui/src/components/ConversationDrawer.tsx` (new): drawer UI; polls
     `requestAgentConversation` on open + every **1800 ms**; renders comic bubbles; sends replies
     via `sendAgentPrompt`; opens scrolled to newest.
   - New wire messages: **client** `requestAgentConversation`, `sendAgentPrompt`; **server**
     `agentConversation`. `server/src/clientMessageHandler.ts` gained ~211 lines handling them.
   - `webview-ui/src/index.css` (+39 lines of drawer styling); wiring in `App.tsx`,
     `BottomToolbar.tsx`, `useExtensionMessages.ts`. Test: `server/__tests__/conversation.test.ts`.
2. **Deterministic agent display names**:
   - `server/src/agentNames.ts` (new): FNV-1a hash of `sessionId` indexes a fixed first-name
     pool; `normalizeFolderSurname(folderName)` → surname; `getAgentDisplayName(sessionId,
folderName)` → "First Surname". `AGENT_FIRST_NAME_COUNT` exported. Test:
     `server/__tests__/agentNames.test.ts`.
   - Wire: `agentCreated` gains `displayName`; `existingAgents` gains `displayNames`
     (map of agentId → name).
3. **Previous-sessions re-employment**:
   - Wire: server `previousSessions` with `PreviousSession { sessionId, displayName, folderName,
folderPath, lastActivity }`.
   - `core/src/provider.ts` adds optional `getSessionInfo?(transcriptPath): SessionInfo` and
     `isSessionActive?(sessionId): boolean` (active-writer detection); `buildLaunchCommand`
     gains `initialPrompt`; new `buildPromptCommand?`.
   - `server/src/types.ts` `AgentState` gains `isGlobalSession?` (globally-scanned sessions,
     removed when inactive). Touches `fileWatcher.ts`, `dismissalTracker.ts`,
     `hookEventHandler.ts`, `transcriptParser.ts`.
4. **Codex provider expansion**: `codex.ts` (+59 lines), `codex.test.ts`, `claude.ts` updated to
   the new `buildPromptCommand`/`initialPrompt` interface.
5. **New bundled default layout**: `webview-ui/public/assets/default-layout-2.json` (new).
6. **Electrobun desktop migration plan**: `ELECTROBUN_MIGRATION_PLAN.md` (new, 604 lines) — see §11.

**Touched-but-modified** (not new): `adapters/vscode/PixelAgentsViewProvider.ts`,
`adapters/vscode/agentManager.ts`, `core/asyncapi.yaml`, `core/src/messages.ts`,
`webview-ui/src/office/{components/OfficeCanvas,components/ToolOverlay,engine/existingAgents,
engine/officeState,types}.ts`, `webview-ui/test/existingAgents.test.ts`.

## 11. Electrobun desktop migration — the big pending plan

**`ELECTROBUN_MIGRATION_PLAN.md`** (604 lines, untracked) is a **not-yet-started** plan to
replace the VS Code extension + browser transports with an **Electrobun desktop app**
(main process + bundled CEF renderer). Read it before any desktop work. Status: **planning;
P0 implementation pending; document/source/API review only — no test claims.**

### The shape of the target

- **Renderer**: CEF on every target (no silent native-webview fallback). UI loads via
  `views://mainview/index.html`; app code calls typed RPC only.
- **Main runtime**: spike **Cottontail** first, then Bun; pick ONE runtime for all release
  targets. A Node sidecar is a last resort requiring a separate architecture amendment.
- **Providers**: Claude and Codex available concurrently in one office (provider-qualified
  `SessionKey = {providerId, sessionId}`, not a numeric agent ID).
- **Remove** (only after desktop parity is verified): the VS Code extension, public browser
  app, custom UI WebSocket route, browser token handling, extension/npm application publishing.
  **Keep** a private loopback HTTP listener solely for provider hooks + limited host control.
  Do NOT remove provider hook authentication.
- **Data**: retain `~/.pixel-agents` as the stable root, with an isolated `desktop/` subtree
  (`config.json`, `state.json`, `layout.json`, `window.json`, `migration.json`, `instance.lock`,
  `logs/`, `backups/<id>/`).
- **Windows**: one office window per user-data profile; second launch focuses the first.
  Closing the last window quits (no tray/background mode in v1).
- **Package manager**: keep npm workspaces + `package-lock.json`; do not add a second lockfile.

### Target module layout (from the plan)

```
electrobun.config.ts   App/build/CEF config (satisfies ElectrobunConfig)
hutch.config.ts        npm delegation + toolchain selection (packageManager:'npm')
desktop/src/
  main.ts, appHost.ts (ordered start/stop, service ownership), window.ts (CEF window),
  nativeServices.ts (dialog/menu/path SDK wrapper), singleInstance.ts (profile lock),
  rpcHandlers.ts (validate → command service → Result), eventBridge.ts (subscriptions,
  snapshots, revisions), rpcSchema.ts (type-only mapping), paths.ts, logging.ts, updates.ts
core/src/desktop/      types.ts, requests.ts, events.ts, validation.ts
server/src/
  runtimeHost.ts (provider coordinator), commands/ (agents, settings, layouts, history),
  processSupervisor.ts (owned children + turn locks), providerRegistry.ts (both providers),
  hookServer.ts (loopback ingress + authenticated focus), hookRegistry.ts, persistence/
webview-ui/src/host/
  desktopClient.ts (single Electroview instance), client.ts (injectable interface)
  hooks/useDesktopState.ts (bootstrap, reducer, event subscriptions)
scripts/               build-desktop-assets.mjs, build-hook-helper.mjs, run-desktop-dev.mjs,
                       smoke-desktop.mjs, verify-desktop-package.mjs
```

Dependency direction: `desktop → server → core`, `webview-ui → core`. Only `desktop/` and
`webview-ui/src/host/desktopClient.ts` import the Electrobun runtime SDK. Core DTOs must not
import React, `fs`, providers, Electrobun values, sockets, or child-process handles.

### Key design decisions in the plan

- **RPC over WebSocket**: named requests with explicit `RpcResult<T>` (ok/error with
  `ErrorCode`, `retryable`), mutation context (`requestId`, `clientId`, `epoch`), and
  revisioned `EventEnvelope` for main→renderer events. The `bun` key is the SDK's name
  even when the runtime is Cottontail.
- **Process supervisor**: all launches/replies pass through `ProcessSupervisor` with
  `{operationId, providerId, sessionKey, cwd, child, state, ownership:'app'}`. Serialize
  turns per session key; a second in-flight turn → `SESSION_BUSY`. Never `detached:true` +
  `unref()` as the lifecycle strategy. 20,000-char prompt limit.
- **Hook helper**: build provider-specific hook entrypoints into one self-contained helper
  executable per target (pinned Bun compile initially). Install under
  `~/.pixel-agents/hooks/desktop/<version>/<platform-arch>/`. No Node on PATH required.
- **Bootstrap**: race-free algorithm — renderer installs event handler + marks hydrating
  before calling bootstrap; main captures revision R + deep immutable snapshot synchronously
  at a queue barrier; events arrive before RPC response so renderer buffers them; limit
  pending events to 2,000 or 8 MiB.
- **Persistence**: versioned schema (v1), atomic writes, migration journal + backups,
  one serialized repository per profile.
- **Update**: explicit check/download/restart flow; no forced restart during a turn.
  `Updater` states: `idle/checking/available/downloading/ready/applying/error`.

### Ordered phases (P0–P9)

| Phase                               | Deliverable                                                                     | Exit gate                                              |
| ----------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **P0** Baseline + compatibility     | Baseline report, toolchain pin, runtime/CEF/helper/process/CDP spikes           | Reproducible packaged fixture app on candidate targets |
| **P1** Desktop skeleton/build       | Configs, SDK aliases, scripts, CEF window, logging                              | Dev + packaged UI load `views://`, clean quit          |
| **P2** Persistence foundation       | Injected paths, validators, profile repository, migration                       | Migration/failure/idempotence fixtures pass            |
| **P3** Runtime extraction/lifecycle | `runtimeHost`, `commands/`, `processSupervisor`, `providerRegistry`             | Provider-isolation tests pass                          |
| **P4** Providers/processes/helper   | Both providers, qualified identity, managed turns, CLI detection, stable helper | Mixed-provider + real-provider smoke pass              |
| **P5** RPC + snapshot bridge        | Validated request/event contract, snapshot projection, subscriptions            | Ordering/race/error tests; CEF round-trip              |
| **P6** Renderer/native parity       | `DesktopClient`, reducer, history, editor/settings, folders/menus               | UI action matrix + desktop smoke pass                  |
| **P7** Cross-platform hardening     | Native CI, packaged tests, redacted diagnostics                                 | Every target passes clean + upgraded-profile gates     |
| **P8** Release/update pipeline      | Signing, verified installers, channel hosting, update/rollback                  | N→N+1 upgrade + busy-turn checks pass                  |
| **P9** Legacy removal/cutover       | Deleted adapters/transports/build/publish paths                                 | Clean checkout builds desktop only                     |

### Legacy removal checklist (P9)

Remove `adapters/vscode/`, VS Code terminal/activation/uninstall code, `server/src/cli.ts`,
combined `server.ts`/`httpServer.ts`, WebSocket transport, `PostMessageTransport`,
`@fastify/static`, `@fastify/websocket`, `@fastify/cors`, `core/asyncapi.yaml` +
`core/src/messages.ts` + generator scripts (after the typed desktop contract replaces them),
`esbuild.js` (rewritten as asset/helper preparation), extension/npm publishing scripts,
and `.github/workflows/publish-extension.yml`. Audit all `vscode`, `/ws`, `WebSocketTransport`,
`acquireVsCodeApi`, `PIXEL_AGENTS_PROVIDER` references with `rg`.

## 12. Testing — three tiers

### Tier 1: Server (Vitest, `server/__tests__/`, 33 files)

Run: `npm run test:server`.

| Area                  | Files                                                                          |
| --------------------- | ------------------------------------------------------------------------------ |
| State store / routing | `agentStateStore`, `sessionRouter`, `hookEventHandler`, `fileWatcherDismissal` |
| Runtime / lifecycle   | `agentRuntime`, `agentRuntime.restorePalette`, `backgroundAgents`              |
| Persistence / config  | `fileStateAdapter`, `configPersistence`, `migrateVsCodeState`                  |
| HTTP / WS             | `server`, `httpServerWs`, `clientMessageHandler`, `cli`                        |
| Claude provider       | `claude`, `claudeTeamProvider`, `claudeHookInstaller`, `claude-hook`           |
| Codex provider        | `codex`, `codexHookInstaller`                                                  |
| Consent               | `consentCopy`, `consentFlow`, `consentGate`                                    |
| Detection / context   | `transcriptParser`, `contextUsage`, `agentActivityResend`, `agentDiagnostics`  |
| Palette / assets      | `paletteAssigner`, `assetReload`                                               |
| Teams / utils         | `teamUtils`                                                                    |
| **New (in-progress)** | `conversation`, `agentNames`                                                   |
| E2E runner            | `mockClaudeRunner`                                                             |

### Tier 2: Webview (Vitest, Node runner, `webview-ui/test/`, 10 files)

Run: `npm run test:webview`.

`existingAgents`, `build-subpath`, `dev-assets`, `greeter`, `introBubbleGeometry`,
`introTour`, `layoutSerializer`, `officeCanvasCursor`, `petEntity`, `teammateSeating`.

### Tier 3: E2E (Playwright, real VS Code + standalone)

Run: `npm run build && npm run e2e`.

- **Mock claude**: tests never invoke real `claude`. A bash script (`e2e/fixtures/mock-claude`)
  is copied into an isolated `bin/` and prepended to `PATH`. The scenario runner
  (`mock-claude-runner.cjs`) honors `claudeScenario(...).at(ms).appendJsonl(record).emitHook(event)
.holdOpenFor(ms).build()`.
- **Isolation**: each test gets its own `tmpHome`, workspace dir, VS Code `--user-data-dir`,
  and mock-log file.
- **Suites**: `e2e/tests/claude/hooks-on/` (basic, lifecycle, teams),
  `e2e/tests/claude/hooks-off/` (lifecycle, matrix), `e2e/tests/standalone/` (hooks).
- **Auto-inventory**: `e2e/README.md` has an auto-generated section between
  `<!-- BEGIN:E2E-INVENTORY -->` / `<!-- END:E2E-INVENTORY -->` markers. CI regenerates via
  `npm run e2e:inventory` and fails on `git diff --exit-code e2e/README.md`.
- **CI**: 3-OS × 3-shard matrix (Linux, macOS, Windows) at `--workers=1`.
- **Allure reports**: `npm run test:report` builds combined report. `file://` can't fetch —
  use `npx allure open allure-report/allure`.

### Package contract

`npm run test:package-contract` + `npm run verify:npm-package`: the verifier runs the
production `prepack` build, creates a tarball outside the repo, installs that exact tarball
into a temp project, and exercises CLI help, health endpoint, standalone SPA, bundled assets,
and default Hook ON setup.

## 13. Build & dev, TypeScript/style constraints, gotchas

### Build outputs (`esbuild.js`)

Three bundles + assets + uninstall hook, all from the repo root:

1. **Extension** `dist/extension.js` from `adapters/vscode/extension.ts` (external: `vscode`).
2. **CLI** `dist/cli.js` from `server/src/cli.ts` (externals: `fastify`, `@fastify/*`).
3. **Hooks** `dist/hooks/{claude-hook,codex-hook}.js` from
   `server/src/providers/hook/<id>/hooks/<id>-hook.ts` (CJS, `#!/usr/bin/env node` shebang).
4. **Uninstall** `dist/uninstall.js` from `adapters/vscode/uninstall.ts`.
5. **Assets** `webview-ui/public/assets/` copied → `dist/assets/`.
6. **Webview** built by Vite → `dist/webview/` (`outDir: '../dist/webview'`, `base: './'`).

`define: { 'process.env.PIXEL_AGENTS_VERSION': JSON.stringify(version) }` stamps the
`package.json` version into all bundles. `package.json:files` allowlist controls the npm
tarball. `dist/extension.js` is intentionally excluded from npm (ships via the `.vsix`).

### Dev workflow

```bash
npm run watch                       # parallel esbuild watch + tsc --noEmit watch
cd webview-ui && npm run dev        # Vite dev server (~http://localhost:5173) — run separately
# F5 in VS Code launches the Extension Development Host with the local extension loaded
```

### TypeScript constraints

- **No `enum`** (`erasableSyntaxOnly` in webview) — use `as const` objects
  (`TileType`, `CharacterState`, `Direction`, `EditTool`).
- **`import type`** required for type-only imports (`verbatimModuleSyntax` in webview).
- **`noUnusedLocals` / `noUnusedParameters`** — strict everywhere.
- **`.js` extensions** on all relative imports in extension + server (Node16 module resolution).
- **Module Node16, target ES2022** in extension/server; **`erasableSyntaxOnly`,
  `verbatimModuleSyntax`, `noFallthroughCasesInSwitch`** in the webview.

### Constants policy (no inline magic numbers)

| Where                              | What                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| `server/src/constants.ts`          | All timing/scanning constants (shared by extension + standalone)                       |
| `adapters/vscode/constants.ts`     | VS Code-only IDs, command names, workspace state keys                                  |
| `core/src/constants.ts`            | Protocol-level constants (transport state names, hook API prefix, display max lengths) |
| `webview-ui/src/constants.ts`      | Webview grid, animation, rendering, camera, zoom, editor, game-logic numbers           |
| `webview-ui/src/index.css` `:root` | CSS custom properties (`--pixel-*`)                                                    |

### Error handling & logging

- **Try-catch with graceful degradation** — errors logged but never crash the extension.
- **Malformed JSONL lines** silently ignored (catch block in `processTranscriptLine`).
- **Missing assets** logged with warning, operation continues with null/fallback.
- No centralized error reporting or telemetry.
- Logging: `console.log`/`error`/`warn` with prefixed context — `[Pixel Agents]`,
  `[Extension]`, `[AssetLoader]`, `[Webview]`.

### Condensed lessons (hard-won, do not re-learn)

- `fs.watch` unreliable on Windows — always pair with polling backup.
- Partial line buffering essential for append-only file reads (carry unterminated lines).
- Delay `agentToolDone` 300 ms to prevent React batching from hiding brief active states.
- **Idle detection** has two signals: (1) `system` + `subtype:"turn_duration"` (reliable for
  tool-using turns, ~98%); (2) text-idle timer (5 s) for text-only turns. Only starts when
  `hadToolsInTurn` is false; suppressed once it becomes true; reset on new user prompt or
  `turn_duration`; cancelled by ANY new JSONL data.
- User prompt `content` can be string or array — handle both.
- `/clear` creates a NEW JSONL file (old file just stops).
- `--output-format stream-json` needs non-TTY stdin — can't use with VS Code terminals.
- Hook-based IPC failed in early prototypes (hooks captured at startup, env vars don't
  propagate). HTTP `/api/hooks/:providerId` with `~/.pixel-agents/server.json` discovery works.
- PNG→SpriteData: pngjs for RGBA buffer, alpha threshold 2, supports `#RRGGBBAA`.
- OfficeCanvas selection changes are imperative (`editorState.selectedFurnitureUid`); must
  call `onEditorSelectionChange()` to trigger React re-render for toolbar.
- **External-session adoption**: scanner runs every 3 s. In hooks-OFF mode, the test setup can
  race the first scanner tick. Mock-claude scenarios should give a few seconds of margin.
- **Context usage is a snapshot against a provider-declared window** — cumulative sums measure
  spend not occupancy; `input_tokens` without cache counters measures almost nothing; a 200k
  window assumed for a 1M model reads five times too full.
- **E2E over webview unit tests** for OSS friction: community PRs change webview internals
  constantly; E2E pins user-facing behavior which is stable across internal refactors.

### Project identity

- Extension ID: `pablodelucca.pixel-agents` (VS Code Marketplace + Open VSX)
- npm package: `pixel-agents` (CLI bin: `pixel-agents`)
- GitHub: `https://github.com/pixel-agents-hq/pixel-agents`
- License: MIT

## 14. Quick reference — where to look for X

| I want to…                                      | Look at                                                                                |
| ----------------------------------------------- | -------------------------------------------------------------------------------------- |
| Understand the wire protocol                    | `core/asyncapi.yaml` → `core/src/messages.ts` (generated)                              |
| Add a new provider (CLI integration)            | `server/src/providers/hook/<id>/` + register in `providers/index.ts`                   |
| Change agent status detection                   | `server/src/hookEventHandler.ts`, `transcriptParser.ts`, `fileWatcher.ts`              |
| Change the office rendering                     | `webview-ui/src/office/engine/` (officeState, characters, renderer, gameLoop)          |
| Add a UI component / change styling             | `webview-ui/src/components/`, `index.css` (CSS vars), `eslint-rules/`                  |
| Change persistence / config                     | `server/src/fileStateAdapter.ts`, `configPersistence.ts`, `layoutPersistence.ts`       |
| Change consent flow                             | `server/src/providers/hook/consentGate.ts`, `consentExecutor.ts`, `docs/adr/0001-*.md` |
| Change the layout editor                        | `webview-ui/src/office/editor/`, `layout/layoutSerializer.ts`                          |
| Add a wire message                              | Edit `core/asyncapi.yaml`, run `npm run asyncapi:generate`, commit `messages.ts`       |
| Run the full test suite                         | `npm test` (webview + server + package-contract)                                       |
| Run e2e tests                                   | `npm run build && npm run e2e` (needs VS Code download on first run)                   |
| Build for release                               | `npm run package` (production esbuild + vite)                                          |
| Understand the Electrobun plan                  | `ELECTROBUN_MIGRATION_PLAN.md` (604 lines)                                             |
| Look up the project glossary                    | `CONTEXT.md` (canonical vocabulary)                                                    |
| Understand the compressed reference             | `CLAUDE.md` (this file's sibling; read both)                                           |
| Change the default office layout                | `webview-ui/public/assets/default-layout-N.json` (highest N wins)                      |
| Understand the in-progress conversation feature | §10 above + `server/src/conversation.ts`, `ConversationDrawer.tsx`                     |
| Understand deterministic agent names            | `server/src/agentNames.ts`, `server/__tests__/agentNames.test.ts`                      |
| Understand Codex specifics                      | §8 above + `server/src/providers/hook/codex/codex.ts`, `docs/providers/codex.md`       |

---

_Generated 2026-09-19. Verify load-bearing claims against the current tree before relying on
them. The in-progress work (§10) is uncommitted; the Electrobun migration (§11) is not started._
