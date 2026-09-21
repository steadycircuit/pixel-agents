# Pixel Agents: Electrobun Desktop Implementation Plan

Last revised: 2026-09-21. Implementation status: **in progress** (Linux x64 verified; see the status block in section 13).

This document specifies the migration, including module boundaries, request contracts, persistence, process ownership, build outputs, tests, and release gates. It is based on the current working tree, including the conversation, deterministic-name, dismissal, and Codex changes already present. It does not claim that those changes pass tests or that an Electrobun build has been verified.

## 1. Outcome and scope

Ship one desktop application with an Electrobun main process and a bundled CEF renderer. Preserve the React/Canvas office, layout editor, assets, pets, areas, Claude teams/subagents, activity and permission indicators, context usage, discovery, previous-session roster, conversation history, replies, deterministic names, and durable seats/dismissals.

The application must work without VS Code, a browser URL, a separately running Pixel Agents server, or a user-installed JavaScript runtime for Pixel Agents itself. Provider CLIs and their authentication remain user-managed prerequisites.

Remove the VS Code extension, public browser application, custom UI WebSocket route, browser token handling, and extension/npm application publishing after desktop parity is verified. Keep a private loopback HTTP listener solely for provider hooks and limited host control. Do not remove provider hook authentication.

**Transport clarification:** the requirement is no application-owned WebSocket transport or HTTP-served UI. Electrobun's `Electroview` RPC itself uses an encrypted loopback transport with native-bridge fallback. Do not assert that the framework opens no sockets or prohibit its own transport. The packaged UI must load through `views://mainview/index.html`; application code calls typed RPC only. [Electroview reference](https://framework.blackboard.sh/electrobun/apis/browser/electroview-class/)

### Product decisions for this implementation

| Area                     | Decision                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Renderer                 | CEF on every supported target; no silent native-webview fallback                                                                     |
| Main runtime             | Spike Cottontail first, then Bun; select one runtime for all release targets before extraction proceeds                              |
| Runtime fallback         | A Node sidecar requires a separate architecture amendment after both integrated options fail                                         |
| Providers                | Claude and Codex available concurrently in one office; selection is explicit per launch and agent                                    |
| Agent interaction        | Desktop launches managed, non-interactive turns; existing terminal sessions are observed; no embedded terminal/PTY in this migration |
| Active external sessions | History remains readable; disable replies/resume while another writer owns the session; explain the reason in the drawer             |
| Permissions              | Preserve provider approvals; never automatically enable permission-bypass flags to make headless turns succeed                       |
| Windows                  | One office window per user-data profile; second launch focuses the first                                                             |
| Closing                  | Closing the last window quits on every OS; no tray/background mode in version one                                                    |
| Data                     | Retain `~/.pixel-agents` as the stable root, with an isolated `desktop/` subtree                                                     |
| Updates                  | Explicit check/download/restart flow; no forced restart during a turn                                                                |
| Migration coexistence    | Old targets remain buildable during implementation, but desktop is a separate entrypoint, not a runtime compatibility flag           |
| Package manager          | Keep npm workspaces and `package-lock.json`; do not introduce a second dependency lockfile                                           |

Concurrent providers and external-session reply gating are deliberate specifications: current code supports one selected provider per process and does not safely inject input into arbitrary terminal sessions.

### Release target matrix

Plan native builds for macOS ARM64, Windows x64, Linux x64, and Linux ARM64. Current upstream documents those core targets and no macOS x64 core artifact; Windows ARM emulation is not a native ARM release. Phase 0 must verify **CEF artifacts as well as core artifacts** for every target. A missing CEF artifact blocks that target; it does not justify silently switching renderers. Build and test on each target's native OS/architecture. [Platform guidance](https://github.com/blackboardsh/electrobun/blob/main/docs/src/content/docs/electrobun/guides/cross-platform-development.mdx)

Record exact minimum OS versions, Linux distributions/glibc baseline, runner labels, and graphics requirements from the selected release and clean-machine tests. Until that evidence exists, these are candidate release targets, not a published support promise. Start Linux validation on Ubuntu 24.04 with X11 and Wayland sessions. Include its required GTK/WebKitGTK/AppIndicator/librsvg packages even for CEF builds. [Linux runtime requirements](https://github.com/blackboardsh/electrobun/blob/main/docs/src/content/docs/electrobun/guides/cross-platform-development.mdx)

## 2. Current implementation and migration hazards

| Existing implementation                                                                                                                   | Required change                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `server/src/cli.ts` loads assets, installs hooks, scans sessions, starts HTTP and exits from signal callbacks                             | Extract lifecycle without importing a CLI, using `__dirname`, assuming launch CWD, or calling `process.exit()` inside runtime services |
| `server/src/server.ts` reuses servers by `servesSpa`, writes `server.json` and `servers/<pid>-<port>.json`; `stop()` does not await close | Desktop owns its listener, never reuses a legacy runtime, and awaits shutdown                                                          |
| `server/src/httpServer.ts` combines hooks, health, CORS, static serving and `/ws`                                                         | Extract hook/control HTTP only; remove static/CORS/WebSocket plugins from the final graph                                              |
| `server/src/agentStateStore.ts` already uses `EventEmitter`                                                                               | Keep the store; type its domain events and snapshot projection instead of replacing it with another socket abstraction                 |
| `server/src/clientMessageHandler.ts` combines commands, consent, handshake, history and detached process spawning                         | Extract command services; surface failures as RPC results; track every owned process                                                   |
| `server/src/providers/index.ts` exports one `activeProvider` selected by `PIXEL_AGENTS_PROVIDER`                                          | Registry of both providers; provider-aware runtime, scanner, parser, settings and identity                                             |
| `core/src/messages.ts` is generated from `core/asyncapi.yaml`                                                                             | Keep generation while legacy targets exist; add an independent typed desktop contract, then retire generation after its last consumer  |
| `core/src/schemas.ts` contains TypeScript interfaces, not runtime validators; UI layout types include additional features                 | Consolidate the complete layout DTO and add actual validators; avoid dropping areas/pets/other UI fields                               |
| `webview-ui/src/hooks/useExtensionMessages.ts` depends on handshake order                                                                 | Replace with snapshot hydration and revisioned events; preserve all activity/team/subagent/context states                              |
| `webview-ui/src/App.tsx` gates the conversation drawer and focus behavior on browser mode                                                 | Make those desktop features; replace runtime booleans with explicit host capabilities                                                  |
| `webview-ui/vite.config.ts` writes `dist/webview` and serves browser mock assets                                                          | Add desktop output and SDK resolution; remove browser middleware after migration                                                       |
| Hook installers construct `node "...hook.js"`                                                                                             | Ship a standalone hook helper; installed provider commands must not require Node on PATH                                               |
| `layoutPersistence.loadLayout()` replaces a saved layout when bundled revision increases                                                  | Desktop must preserve custom layouts; only explicit reset replaces one                                                                 |
| `FileStateAdapter` writes per-namespace agents/seats, some errors only log                                                                | Introduce validated, versioned desktop storage whose failures propagate to the UI                                                      |
| Current launch/reply paths use detached children and `unref()`                                                                            | Add ownership, spawn acknowledgement, cancellation and shutdown semantics                                                              |

### Data to inventory before implementation

Read the raw files, not only `readConfig()`: that function supplies defaults and hides whether a namespace was actually present.

| Source                                              | Contents                                                                                                     | Desktop treatment                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `~/.pixel-agents/config.json`                       | `standalone`/`vscode` settings; shared external directories, hook consent/preferences, dismissed session IDs | One-time validated import; preserve source                                             |
| `~/.pixel-agents/standalone-state.json`             | Persisted agents and numeric-keyed seats                                                                     | Preferred source for desktop agents/seats                                              |
| `~/.pixel-agents/vscode-state.json`                 | VS Code agents/seats                                                                                         | Fallback only when standalone state is absent; never merge numeric IDs blindly         |
| `~/.pixel-agents/layout.json`                       | Shared user layout                                                                                           | Copy to desktop profile without resetting to a newer bundled default                   |
| `~/.pixel-agents/hooks/`                            | Installed scripts                                                                                            | Preserve during transition; add versioned desktop helper installations                 |
| `~/.pixel-agents/server.json`, `servers/*.json`     | Legacy discovery records containing tokens                                                                   | Compatibility discovery only; never import as preferences                              |
| `~/.claude/settings.json`, `~/.codex/hooks.json`    | Provider hooks, including third-party entries                                                                | Modify only owned entries through provider consent/install services                    |
| VS Code workspace/global state not already exported | Older extension-only state                                                                                   | Document running the old extension's migration/export; do not scrape VS Code databases |

Capture the chosen default asset index: `core/src/assets/build.ts` chooses the highest numbered `default-layout-N.json`; the working tree contains `default-layout-2.json`. Preserve `ZOOM_DEFAULT = 6` unless an explicit product change is made.

## 3. Target modules and dependency rules

```text
electrobun.config.ts                  App/build/CEF configuration
hutch.config.ts                      npm delegation and toolchain selection
desktop/
  tsconfig.json
  src/
    main.ts                          SDK entrypoint and startup failure boundary
    appHost.ts                       Ordered start/stop, service ownership
    window.ts                        CEF window, bounds, readiness, navigation
    nativeServices.ts                Dialog/menu/path-opening SDK wrapper
    singleInstance.ts                Profile lock and focus-existing protocol
    rpcHandlers.ts                   Validate -> command service -> Result
    eventBridge.ts                   Renderer subscriptions, snapshots, revisions
    rpcSchema.ts                     Type-only Electrobun mapping
    paths.ts                         Install/resource/data locations
    logging.ts                       Rotating logs and diagnostic redaction
    updates.ts                       Updater state machine and restart gating
  test/                              Host, native wrapper and bridge tests
core/src/desktop/
  types.ts                           JSON DTOs and discriminated unions
  requests.ts                        Request params/results, error codes
  events.ts                          Event payloads and snapshot schema
  validation.ts                      Runtime validation and payload limits
server/src/
  runtimeHost.ts                     Provider runtime coordinator
  commands/                         Agents, settings, layouts, assets, history
  processSupervisor.ts               Owned child processes and turn locks
  providerRegistry.ts                Both providers and capability records
  hookServer.ts                      Loopback ingress + authenticated focus
  hookRegistry.ts                    Registration/heartbeat/stale cleanup
  persistence/                       Profile store, migration, atomic writes
  ...                                Existing runtime/provider/parser modules
webview-ui/src/
  host/desktopClient.ts              Single Electroview instance
  host/client.ts                     Injectable typed renderer-facing interface
  hooks/useDesktopState.ts           Bootstrap, reducer, event subscriptions
scripts/
  build-desktop-assets.mjs
  build-hook-helper.mjs
  run-desktop-dev.mjs
  smoke-desktop.mjs
  verify-desktop-package.mjs
```

Keep the existing `server/` and `webview-ui/` names through migration to reduce rename churn; their final role is runtime and renderer, not network server/public web app.

Dependency direction: `desktop -> server -> core` and `webview-ui -> core`. Only `desktop` and `webview-ui/src/host/desktopClient.ts` import the Electrobun runtime SDK. Core DTOs must not import React, `fs`, provider implementations, Electrobun runtime values, sockets, or child-process handles. Keep SDK schema types in `desktop/src/rpcSchema.ts`; the renderer imports them with `import type` only. Test mocks implement the same `DesktopClient` interface.

`StateAdapter` may remain an internal storage seam while extraction proceeds; remove VS Code terminal behavior from domain contracts when its consumers are migrated. Desktop-native functions are dependency-injected so server tests never open a window/dialog.

## 4. Toolchain and CEF compatibility gate

### 4.1 Pin and prove the toolchain

Add `docs/desktop/toolchain.md` during Phase 0 with exact Electrobun npm release, paired Hutch version, runtime version, CEF version, Node/npm development versions, checksums/artifact availability and tested OS versions. No version is asserted here because none has been installed or exercised in this repository. Use the exact successful release, not `latest`, `^`, or a floating channel.

Keep `npm ci` and the existing Node 22 development baseline, validating the exact patch against Vite 8 and the other installed tools. Add an exact `electrobun` devDependency: current upstream's npm launcher supplies its paired Hutch toolchain. Set `packageManager: 'npm'` in `hutch.config.ts`, and use the package-local launcher from npm scripts; do not accidentally let Hutch's built-in resolver create `hutch.lock`. Materialize the generated `.hutch/devkit` before TypeScript/Vite resolve SDK imports, and ignore it in Git. [Hutch toolchain/package-manager behavior](https://framework.blackboard.sh/electrobun/guides/hutch/)

Run the same spike under Cottontail and, if needed, Bun:

- Load Fastify and start/close a loopback listener; authenticate and parse a hook payload.
- Exercise `node:fs`, `fs.watch` with polling fallback, rename, permissions, `node:crypto`, EventEmitter, timers, streams and PNG/asset decoding.
- Spawn a fixture executable, handle `spawn`/`error`/`exit`, stream UTF-8 output, cancel it, and prove descendant cleanup on each OS.
- Exercise both provider parsers, transcript tailing after truncation/rotation, and writer detection using fixture files.
- Import existing modules as ESM without `require.main`, `__dirname`, or dependency-resolution failures; include dynamically loaded dependencies in the packaged test.
- Launch CEF, load a `views://` page, perform a request and an event, reload the renderer, and quit with no owned processes/listeners remaining.
- Run from a packaged build outside the repository and from a GUI launch with a minimal PATH.

Select Cottontail only if all required checks pass across the release matrix. Otherwise record exact failures and select Bun. Do not switch runtimes per OS. A native hook helper is a short-lived provider integration executable, not a persistent Node runtime sidecar.

### 4.2 Build configuration and resource layout

Use `satisfies ElectrobunConfig`. The structural configuration below must be compiled against the pinned SDK. `APP_VERSION` is generated from root `package.json` by the build preparation script; choose `mainProcess` and its matching entrypoint block from the spike result.

```ts
import type { ElectrobunConfig } from 'electrobun';
import { APP_VERSION } from './desktop/generated/buildInfo';

export default {
  app: {
    name: 'Pixel Agents',
    identifier: 'com.pixelagents.desktop',
    version: APP_VERSION,
  },
  build: {
    mainProcess: 'cottontail',
    cottontail: { entrypoint: 'desktop/src/main.ts' },
    copy: {
      'dist/desktop-view': 'views/mainview',
      'dist/desktop-assets': 'assets',
      'dist/desktop-hooks': 'hooks',
    },
    mac: { bundleCEF: true },
    win: { bundleCEF: true },
    linux: { bundleCEF: true },
  },
  runtime: { exitOnLastWindowClosed: false },
} satisfies ElectrobunConfig;
```

Disable automatic exit so `appHost.stop()` can finish before the explicit native quit. For Bun, replace `mainProcess` with `'bun'` and `cottontail` with `bun`. Configure icons and signing separately for each release environment. Confirm the proposed stable application identifier before the first signed release; changing it later affects OS/update identity. [Build configuration](https://framework.blackboard.sh/electrobun/apis/cli/build-configuration/)

Create the window with `renderer: 'cef'` as well as bundling CEF; packaging alone must not select the renderer implicitly. Check `BuildConfig`'s included renderers and inspect the running packaged renderer. Missing CEF is a startup error. [CEF configuration](https://framework.blackboard.sh/electrobun/apis/bundling-cef/)

Vite remains the React/Tailwind bundler. Use `base: './'`, `outDir: '../dist/desktop-view'`, and SDK aliases resolved from the pinned generated devkit for both Vite and TypeScript. Do not assume TypeScript `paths` config rewrites runtime imports. Type-check the main process with SDK/runtime libraries and the renderer with DOM libraries in separate projects. Never include main-process Node shims in the renderer bundle.

Copy bundled asset originals and index/default layout to `dist/desktop-assets` using the existing asset pipeline. Resolve packaged resource paths through the SDK/resource wrapper, never `process.cwd()` or the source directory. Keep raw assets separate from the Vite output if main-process decoding needs them. Assert expected filenames and hashes in a generated resource manifest. No production fonts/audio/images/scripts may depend on a CDN or dev server.

### 4.3 Commands to implement

These are target scripts, not commands already available in the repository:

| Script                   | Implementation                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `desktop:prepare`        | Package-local `electrobun prepare`, generate build metadata, verify pinned SDK/aliases                                                                  |
| `desktop:assets`         | Build/copy asset manifest and native hook helpers for the current target                                                                                |
| `build:renderer`         | Renderer type check followed by Vite desktop build                                                                                                      |
| `desktop:dev`            | Preparation/assets + Vite build watcher + Electrobun dev watcher; wait for initial renderer output before launch; propagate exit and stop both watchers |
| `desktop:build`          | Preparation/assets + renderer build + package-local `electrobun build --env=stable`                                                                     |
| `check-types:desktop`    | Main/SDK, core and renderer project checks                                                                                                              |
| `test:desktop`           | Host, migration, commands, bridge and native-wrapper unit tests                                                                                         |
| `test:desktop:smoke`     | Launch an actual built app with temporary profile and fixture providers                                                                                 |
| `verify:desktop-package` | Inspect artifacts, resources, signatures, helper and CEF contents                                                                                       |

For initial development use watched static builds and `views://` reload, avoiding an additional HMR transport. Only add Vite HMR later as an explicitly development-only path. Keep old `compile`/`package` scripts until the removal phase; make the desktop path independently reproducible first.

## 5. Host lifecycle, identity and resource ownership

Define `createRuntimeHost(deps)` returning `start(): Promise<HostSnapshot>`, `stop(reason): Promise<void>`, command services and a subscription API. Construction/import must not start timers, scan the real home directory, install hooks or open listeners.

### Startup order

1. Resolve profile/resource paths and initialize redacted logging. Use `PIXEL_AGENTS_DATA_DIR` and provider-root overrides for tests; inject these paths everywhere, including installers and dismissal storage.
2. Acquire the desktop profile lock. If a verified live owner exists, request focus and exit without initializing runtime or hooks.
3. Validate/migrate storage and open the serialized writer. Fail visibly on unrecoverable data errors; do not replace corrupt data with defaults and then save over it.
4. Load the complete asset cache and user/default layout; determine a catalog version. Initialize store, settings, ID allocator, provider registry and process supervisor.
5. Create provider runtimes and restore validated agents/seats, observing durable dismissals before any scan. Reconcile restored records with real transcripts/writers; restore never spawns a provider process.
6. Bind hook server on `127.0.0.1:0`, create a random per-start token and publish the registration only after listening succeeds. Queue events until runtime initialization is complete with a bounded queue; overflow requests rescan and emits a diagnostic.
7. Ensure the packaged helper is available; install/update only consented providers. Record enabled, installed, consent and error states separately.
8. Start each provider's project/global scans and stale checks with configured workspace roots. GUI launch CWD is never a workspace default. With no workspace, offer folder selection and allow explicitly enabled global discovery.
9. Attach event bridge, create the CEF window and native menu, then permit bootstrap. Degraded provider installation must not prevent office access; unusable assets/storage must show an actionable startup error.

Each acquired resource registers a disposer immediately. If any later step fails, unwind in reverse order. `start()` is single-flight; `stop()` memoizes its promise and is safe after partial startup.

### Shutdown order

Enter `stopping`; reject new mutating RPCs with `SHUTTING_DOWN`. Stop discovery and hook admission, then request cancellation of owned turns. Allow 5 seconds for graceful termination and another 2 seconds for forced descendant cleanup. Never kill an observed external process. Await HTTP close, flush pending persistence/window bounds/logs, detach subscriptions/watchers/timers, remove only matching own registry/lock records, and finally invoke native quit. A shutdown timeout logs the failed resources before exit.

Route window close, Quit, updater restart, SIGINT/SIGTERM and unrecoverable main errors through the same path. Closing with owned active turns presents a native cancel/quit confirmation; renderer reload keeps the runtime and processes alive. A crash cannot guarantee cleanup: stale registration pruning and restart reconciliation must handle it.

### Single-instance and discovery

Use an atomic exclusive profile lock with `{pid, instanceId, startedAt, port}` and owner-only access. An existing PID alone is insufficient because of PID reuse: confirm the instance ID using an authenticated local health/control request. A second desktop launch reads the protected registration and calls an authenticated, fixed `POST /api/desktop/focus`; no shell commands or arbitrary URLs are accepted. A stale lock is removed only after owner verification fails; serialize racing launches and retry acquisition.

Keep legacy hook discovery records compatible during transition, but never let `servesSpa: false` cause desktop to reuse the VS Code server. Add a backward-compatible host-kind/capability field and protocol handling to the registry. Hook fan-out may reach legacy servers while both products run. Delete only the desktop instance's registration, and clear `server.json` only if it still identifies that instance. Test shutdown while another server owns the legacy pointer.

## 6. Provider coordination and managed processes

### 6.1 Provider-aware state

Create `ProviderId = 'claude' | 'codex'` and a registry of both `HookProvider`s. Replace implicit `activeProvider` imports in command handlers, discovery, history and hook routing with injected provider lookup. Start by retaining one `AgentRuntime` per provider under a coordinator; audit every scan/stale-check/store loop so each runtime only processes its own agents. Use one global numeric UI ID allocator and one store to avoid collisions.

Every agent/session/previous-session DTO has `providerId`. Durable identity is `SessionKey = {providerId, sessionId}` serialized canonically, not a numeric agent ID or folder name. Team/subagent references use provider-qualified identities as well. Persist stable session keys for seats/dismissals; maintain numeric IDs only for renderer compatibility. Include capabilities per provider, and resolve reading tools/subagent tools per agent when animating a mixed office.

Make hook preferences, consent, availability, installed status and errors per provider. A hook dispatch first validates provider ID/protocol, then invokes only that runtime's normalizer. Claude team behavior and Codex transcript parsing must remain isolated. Normalize folder comparisons with `pathKey.ts`, preserving filesystem case semantics and realpath rules.

### 6.2 Process supervisor

All launches, re-employment and replies pass through `ProcessSupervisor`. Track `{operationId, providerId, sessionKey?, cwd, child, state, startedAt, exitCode, ownership:'app'}`. Use `spawn(executable, args, {cwd, env, shell:false})`, a validated executable path, and bounded stdout/stderr capture; never interpolate prompts or paths into shell commands.

Resolve executables using configured absolute paths plus a bounded PATH search. GUI launch on macOS/Windows may lack the user's terminal PATH. Add native executable selection/settings and `--version` probes with a timeout. Handle Windows npm `.cmd` shims explicitly: resolve the actual launcher/runtime or use a thoroughly tested quoting adapter; do not pass arbitrary prompt text to `cmd /c`. Show missing CLI/authentication/permission errors with setup guidance.

Do not use `detached:true` plus `unref()` as the lifecycle strategy. POSIX process groups may be used while retaining ownership/handles; on Windows use a tested job-object/native helper strategy to terminate owned descendants. Prove this in Phase 0. Drain pipes, bound capture to the last 64 KiB per stream, and redact by default. Provider authentication tokens and inherited environment must not enter diagnostics.

Serialize turns per session key, rechecking external-writer activity immediately before spawn. A second in-flight turn returns `SESSION_BUSY`; no implicit unbounded queue. A successful RPC means the OS accepted the spawn, not that the provider completed a turn. Publish operation state changes through events. Persist dismissal clearing and retained-session state only after acknowledged spawn; restore prior state on pre-spawn failure.

Current command builders provide these behaviors to preserve and integration-test against recorded CLI versions:

| Action                      | Claude                                      | Codex                                                          |
| --------------------------- | ------------------------------------------- | -------------------------------------------------------------- |
| New non-interactive session | `--print --session-id <id> <initialPrompt>` | `exec <initialPrompt>`; provider assigns the actual session ID |
| Reply/resume                | `--resume <id> --print <prompt>`            | `exec resume <id> <prompt>`                                    |

Do not assume a supplied UUID becomes Codex's session ID. Add launch correlation through machine-readable provider output and/or hook session-start metadata with an operation-scoped environment marker where supported. If correlation cannot be proved, serialize new launches per provider/cwd and report an unassociated operation rather than attaching to the wrong session. A fixture and real-provider smoke test must cover two rapid launches in the same folder.

Use a 20,000-character non-empty prompt limit (matching the existing handler). Preserve drafts on errors. When a provider requires terminal interaction, report that requirement; this migration does not implement terminal keystroke injection. External-writer checks must be provider-specific: implement Claude activity detection too, or conservatively disable replies for external Claude sessions whose ownership cannot be established. Disable unsupported capabilities explicitly in bootstrap.

### 6.3 Lifecycle invariants

- `closeAgent` means dismiss from the office durably; it does not silently terminate external work. An owned active turn requires explicit cancellation before dismissal, or returns `SESSION_BUSY` with a cancel action.
- `cancelAgentTurn` terminates only an app-owned operation and reports cancellation separately from dismissal.
- Normal completion, including Codex `SessionEnd(reason=other)` for a resumed one-shot, leaves a retained agent visible and idle.
- A manual dismissal survives hooks, scans, renderer reload and app restart. Explicit successful re-employment clears it.
- Crash/restart reconciles process/transcript state; numeric IDs may change but names, palette and valid seats follow session identity.
- History reads resolve the transcript from the host's known agent/session mapping. Renderer-supplied arbitrary file paths are never used.
- Previous sessions carry provider, canonical cwd, last activity and eligibility/reason; filter writers at display time and recheck at command time.

## 7. Hook server and standalone helper

Retain Fastify for the initial hook extraction if the compatibility spike passes. The final listener exposes only `POST /api/hooks/:providerId`, a minimal health route and the authenticated fixed focus action. No `/ws`, static file fallback, UI cookies, permissive CORS or renderer command endpoint.

Preserve the existing 64 KiB hook body limit, bearer authentication with length-guarded constant-time comparison, provider/protocol checks and normalized event handling. Bind only loopback, validate Host, reject browser-origin requests, enforce JSON content type and bounded request timeouts. Health without authentication reveals only liveness; tokens/session paths/details require authentication. Return explicit 400/401/404/413/503 errors for invalid payload/auth/provider/size/shutdown. Never log the token or whole hook payload.

### Helper packaging

Build the existing provider-specific hook entrypoints into one self-contained helper executable per target (provider selected by a fixed argument), using a pinned Bun compile toolchain initially. This is build-time tooling even if the app main process uses Cottontail. Test Node API compatibility of the helper separately. If this compile path fails the platform spike, implement a small native helper with the same stdin/registry/POST behavior before proceeding; do not silently require user-installed Node.

Install immutable helper versions under `~/.pixel-agents/hooks/desktop/<helper-version>/<platform-arch>/`. Provider entries invoke the quoted absolute executable plus `--provider claude|codex`; no tokens or application install paths appear in command strings. Publish the helper fully and verify its checksum/executable permissions before modifying provider settings. Update settings atomically to a new version; retain the preceding version for rollback and do not replace a running Windows executable.

The helper reads bounded stdin, discovers registered local targets, applies short per-target deadlines and exits successfully when the desktop is absent; provider work must not fail because the office is closed. Preserve fan-out compatibility, duplicate suppression already implemented, and non-blocking hook behavior. Test installation paths containing spaces, quotes, Unicode and shell metacharacters using the actual provider hook invocation model.

Update Claude's owned-command recognizer and Codex's exact-command recognizer to recognize both old script invocations and the new helper layout. Preserve unknown events/fields/third-party hooks and existing settings-file permissions. Back up provider files before migration; do not overwrite malformed settings. Hook consent retains `install`, `notNow`, and `never` semantics from `consentGate`, `consentExecutor` and the existing consent ADR. A failed installation does not falsely report installed/enabled success. An explicit enable toggle can constitute consent as it does today.

Normal application quit unregisters the host but does not uninstall provider hooks. A settings action removes only Pixel Agents entries. Uninstall documentation must explain disabling hooks first, removing the application and optionally removing its data/helper versions; never delete provider transcript directories.

## 8. Typed RPC, complete action mapping and ordering

### 8.1 Contract shape

Use named requests with explicit results; reserve messages for main-to-renderer events. During transition, an adapter may translate existing `MessageTransport.send/onMessage` calls, but final UI actions await requests instead of dropping failures.

```ts
type RpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: ErrorCode; message: string; retryable: boolean } };

type MutationContext = { requestId: string; clientId: string; epoch: string };
type EventEnvelope = {
  protocolVersion: 1;
  subscriptionId: string;
  epoch: string;
  revision: number;
  event: DesktopEvent;
};
```

Define the SDK schema as `bun: RPCSchema<{requests: DesktopRequests; messages: {}}>` and `webview: RPCSchema<{requests: {}; messages: {event: EventEnvelope}}>` in the type-only mapping. Main uses `BrowserView.defineRPC`, attaches it to the CEF window, and emits `rpc.send.event`. Renderer constructs one `Electroview` from `Electroview.defineRPC` before requesting bootstrap. The `bun` key is the SDK's name even when the selected runtime is Cottontail. [BrowserView RPC](https://github.com/blackboardsh/electrobun/blob/main/docs/src/content/docs/electrobun/apis/browser-view.mdx)

Errors: `INVALID_ARGUMENT`, `NOT_FOUND`, `UNSUPPORTED`, `PROVIDER_UNAVAILABLE`, `SESSION_BUSY`, `CONSENT_REQUIRED`, `CANCELLED`, `CONFLICT`, `IO_ERROR`, `SPAWN_FAILED`, `STALE_CLIENT`, `SHUTTING_DOWN`, `INTERNAL`. Log an internal correlation ID for unexpected failures and return a sanitized message. Runtime validators are required despite TypeScript types. Strictly validate unions, finite numbers, ranges, record keys and size limits; reject unknown methods and prototype-pollution keys.

Bind `clientId`/subscription to the actual main-owned webview; renderer-provided identifiers alone confer no authority. Only the trusted packaged page receives the bridge. Use a restrictive CSP compatible with the verified Electrobun bridge, prevent navigation/popups to arbitrary content, and open approved HTTPS documentation externally. Do not set the main office view to an untrusted/sandboxed mode that disables required RPC without redesigning the bridge.

### 8.2 Renderer-to-main requests

All mutating requests include `MutationContext`; file dialogs return an explicit cancelled result without changing state. Names below define the final interface and map every current client message.

| Request                                              | Parameters and successful response                                                            | Existing action / behavior                                                              |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `getBootstrapState`                                  | `{clientId, protocolVersion:1}` -> snapshot, epoch, revision, subscriptionId                  | Replaces `webviewReady`; installs subscription atomically with snapshot                 |
| `releaseSubscription`                                | `{subscriptionId}` -> void                                                                    | React cleanup/view teardown; idempotent                                                 |
| `launchAgent`                                        | `{providerId, workspaceId, initialPrompt?, bypassPermissions:false\|true}` -> `{operationId}` | Current new `launchAgent`; default bypass false                                         |
| `reEmploySession`                                    | `{sessionKey}` -> `{operationId}`                                                             | Current `launchAgent` with `sessionId`; cwd comes from validated roster                 |
| `focusAgent`                                         | `{agentId}` -> selected agent                                                                 | Select office character/open history; replaces terminal focus                           |
| `closeAgent`                                         | `{agentId}` -> void                                                                           | Persist dismissal then remove; owned busy operation handled explicitly                  |
| `cancelAgentTurn`                                    | `{operationId}` -> operation state                                                            | New owned-process cancellation                                                          |
| `getOperationStatus`                                 | `{operationId}` -> operation state or `NOT_FOUND`                                             | Reconcile timed-out launch/prompt requests without replaying them                       |
| `sendAgentPrompt`                                    | `{agentId, prompt}` -> `{operationId}`                                                        | Current prompt message; enforce one writer                                              |
| `getAgentConversation`                               | `{agentId, cursor?, limit<=200}` -> `{sessionKey, messages, nextCursor?, historyRevision}`    | Current request; bounded pagination, stable message IDs                                 |
| `saveLayout`                                         | `{layout, expectedLayoutRevision}` -> `{layoutRevision}`                                      | Validate full editor format; conflict instead of silent overwrite                       |
| `saveAgentSeats`                                     | `{seats: Record<SessionKeyString, Seat>, expectedSeatsRevision}` -> `{seatsRevision}`         | Translate numeric IDs during compatibility period                                       |
| `setSetting`                                         | Typed key/value union -> updated settings and revision                                        | Sound, version seen, labels, ghost agents, hooks info, watch-all, show-areas            |
| `saveAreaMappings`                                   | `{mappings, expectedSettingsRevision}` -> settings revision                                   | Validate canonical workspace references and existing area labels                        |
| `setHooksEnabled`                                    | `{providerId, enabled}` -> hook state                                                         | Existing toggle, consent and install result                                             |
| `respondHooksConsent`                                | `{providerId, choice:'install'\|'notNow'\|'never'}` -> hook state                             | Existing `hooksConsentResponse`                                                         |
| `selectFolder`                                       | `{purpose:'workspace'\|'assets'}` -> `{selectionId, path}` or cancelled                       | Main issues short-lived selection handle                                                |
| `selectProviderExecutable`                           | `{providerId}` -> validated executable/version or cancelled                                   | Native file selection and bounded version probe; persists provider-specific override    |
| `addWorkspace` / `removeWorkspace`                   | `{selectionId}` / `{workspaceId}` -> workspace list                                           | Persist folders; adjust provider scan scope, preserve active sessions                   |
| `addExternalAssetDirectory`                          | `{selectionId}` -> catalog version/directories                                                | Existing add action via native selection                                                |
| `removeExternalAssetDirectory`                       | `{directoryId}` -> catalog version/directories                                                | Existing remove; retain last valid catalog on failure                                   |
| `getAssetChunk`                                      | `{catalogVersion, assetId, chunkIndex}` -> chunk, count and hash                              | Read-only, version-bound decoded asset access                                           |
| `importLayout` / `exportLayout`                      | Native dialog request -> revision / exported status                                           | Replace browser file input/download and VS Code dialogs                                 |
| `openSessionsFolder`                                 | `{providerId}` -> void                                                                        | Host-derived provider root only                                                         |
| `openLogsFolder`                                     | Empty -> void                                                                                 | Host-derived log path                                                                   |
| `getDiagnostics`                                     | Empty -> redacted typed diagnostics                                                           | Existing diagnostics request                                                            |
| `getAppInfo`                                         | Empty -> app/runtime/CEF versions and platform                                                | Replace `extensionVersion` with `appVersion`                                            |
| `checkForUpdates` / `downloadUpdate` / `applyUpdate` | Empty -> update state                                                                         | Main-owned updater; apply invokes shutdown guard                                        |
| `resetDesktopData`                                   | Explicit scopes + native confirmation -> restart required                                     | Backup then reset desktop data only; preserve provider consent unless separately chosen |
| `quit`                                               | Empty -> accepted/cancelled                                                                   | Native close guard and orderly shutdown                                                 |

For `setSetting`, define a discriminated union so boolean settings cannot receive strings; `lastSeenVersion` is a bounded version string. Preferences that affect scanning are applied before emitting success. An external-folder selection is canonicalized and revalidated at use; the UI cannot smuggle arbitrary paths through a directory ID.

Selection handles are bound to the originating view and purpose, expire after five minutes, and are consumed once. Keep the last 1,000 completed operations for ten minutes so timeout reconciliation remains possible. Native Settings/Diagnostics menu actions send a typed `uiActionRequested` event; reload/devtools/quit execute through fixed native handlers. The main process remains the source of mutation events even when the native menu initiated the action.

Deduplicate mutation `requestId`s per client/epoch with a bounded 10-minute/1,000-result cache; identical in-flight calls share a promise, and reused IDs with different payloads fail. Never automatically retry launch/prompt after timeout. Offer operation status/bootstrap reconciliation; an app restart invalidates the epoch and cannot safely replay process creation.

Use 10-second ordinary RPC timeouts and a separate generous dialog timeout/cancellation policy. Provider turns return promptly with operation IDs; they do not hold RPC requests open for inference. Set an initial 1 MiB control payload limit, 10 MiB validated layout-import limit, and 1 MiB asset chunk limit; exercise these against the pinned bridge and adjust documented limits only with evidence.

Treat bootstrap/layout responses separately from small control messages: permit up to 16 MiB for a validated snapshot, including the layout but excluding decoded sprites/history. Above that limit return an explicit size diagnostic rather than partially hydrating. Bound roster results to 100 per provider initially, report truncation, and keep transcript pagination out of bootstrap. Test UTF-8 byte size, not just JavaScript string length, for transport limits.

### 8.3 Snapshot and event mapping

Bootstrap contains app/capability/provider state, full settings and hook-consent status, workspaces, complete layout with revision, area mappings, seats, agents and their active tools/permissions/subagents/team/context state, previous sessions, operation states, and asset catalog version/manifest. Do not include auth tokens or entire transcript histories. Selected-agent history is requested separately.

| Existing server messages                                                                                                                                                        | Desktop representation                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `providerCapabilities`, `settingsLoaded`, `hooksStatus`, `hooksConsentRequest`, `workspaceFolders`, `areaMappingsLoaded`, `previousSessions`, `externalAssetDirectoriesUpdated` | Snapshot fields plus typed provider/settings/hooks/workspace/roster/catalog change events                       |
| `existingAgents`, `agentCreated`, `agentClosed`, `agentSelected`, `agentStatus`                                                                                                 | Agent snapshot plus create/remove/select/status events                                                          |
| `agentToolStart/Done`, `agentToolsClear`, `agentToolPermission/Clear`                                                                                                           | Preserve semantic events and corresponding snapshot state                                                       |
| `subagentToolStart/Done`, `subagentClear`, `subagentToolPermission`                                                                                                             | Preserve parent/tool identity and clearing behavior                                                             |
| `agentTeamInfo`, `agentContextUsage`                                                                                                                                            | Team/context events and snapshot state                                                                          |
| `layoutLoaded`, furniture/character/pet/floor/wall/carpet loaded events                                                                                                         | Layout snapshot and versioned asset manifest/chunks; invalidate catalog atomically                              |
| `agentConversation`, `agentDiagnostics`                                                                                                                                         | Request results; `conversationChanged` invalidates selected history, diagnostics remain on demand               |
| New desktop state                                                                                                                                                               | `operationChanged`, `runtimeStatusChanged`, `updateStatusChanged`, redacted `diagnosticEvent`, `resyncRequired` |

Do not collapse all tool/subagent events into a vague activity string. Existing reducer behavior depends on their distinct lifecycles. Add provider and session identity wherever numeric IDs alone would be ambiguous.

### 8.4 Race-free bootstrap algorithm

1. Renderer installs its event handler and marks itself hydrating before calling bootstrap. React StrictMode must not create a second SDK instance.
2. Main processes state mutations on one serialized event queue. At a queue barrier, register/replace that client's subscription, capture revision `R` and a deep immutable snapshot synchronously. Do not await disk reads inside this barrier; precomputed caches supply snapshot data.
3. Every subsequent event receives monotonically increasing revision `R+1...` and the current host epoch/subscription ID. Events can arrive before the RPC response, so the renderer buffers them.
4. Renderer validates epoch/protocol, hydrates assets/layout before agents, installs the snapshot at `R`, then applies buffered events with revision greater than `R` in order. Ignore duplicates and prior subscriptions; detect gaps and request a new bootstrap.
5. Limit pending events to 2,000 events or 8 MiB, whichever comes first. Overflow invalidates hydration and requires resync; never silently drop a tool close event. Coalesce only replaceable state such as context usage, before assigning delivery revisions.
6. Reload/disconnect disposes the main subscription and renderer listener. Main tears down dead views even if cleanup RPC never arrives. New epoch means a main restart: discard old operations/events and reconcile through a fresh snapshot.

All mutating store paths, including direct `agent` field changes in parsers/watchers, must update the snapshot projection before publishing an event. Merely numbering `store.broadcast()` calls does not guarantee consistency. Test a tool event during bootstrap, removal during hydration, lost/duplicate events, renderer crash, and multiple rapid reloads.

## 9. Assets, renderer behavior and native UI

### Asset transport

Reuse `buildAssetCache` and `assetReload` with explicit bundled root/external directories. Bootstrap references an immutable catalog version. Bundled static files use `views://` URLs; decoded external sprites use `getAssetChunk({catalogVersion, assetId, chunkIndex})`, returning bounded JSON chunks and total/hash metadata. Add that read-only request to the schema. Cache decoded assets in main, release old versions after clients finish hydration or a bounded grace period, and restart bootstrap if a version expires.

Never expose a general `readFile` RPC or `file://` access. Validate manifest paths against each approved asset root after realpath resolution, enforce image dimensions/decoded size limits, and reject traversal/symlink escapes. Load/rebuild into a new cache, validate it, then swap the catalog and emit one version change. A failed load preserves the prior working office and reports the directory/file error. Preserve palette indices when catalogs grow; handle removal with a deterministic fallback without corrupting persisted seat identity.

### React migration tasks

- Add `DesktopClient` injection and a single SDK-backed implementation. Adapt old messages temporarily with exhaustive switches; unknown messages must fail tests, not disappear.
- Replace `useExtensionMessages` with a snapshot/event reducer. Keep OfficeState mutation and React state synchronized, and suppress `saveAgentSeats` while initial hydration is in progress.
- Audit every `isBrowserRuntime`, VS Code API access, `window.location` token, `WebSocket`, browser mock and runtime-specific control in App, SettingsModal, toolbar, DebugView, editor actions and OfficeCanvas.
- Preserve the conversation drawer for desktop. Initial history opens at the bottom; subsequent updates auto-scroll only when already near the bottom, preserve scroll during older-page loads, and discard late responses for a previously selected agent.
- Fetch history using cursors bounded by transcript generation/offset; handle truncation/rotation with an invalidated cursor response. Render transcript text as text, not untrusted HTML.
- Show prompt progress/errors from operation events; clear input only after accepted spawn, retain the draft on rejection. Disable send with a clear writer/CLI/permission capability reason.
- Persist native-folder workspaces and use them for launch selection/area mappings. Remove browser path text prompts, browser downloads and address-bar instructions.
- Replace the browser connection dot with runtime starting/ready/degraded/stopping state; renderer bridge loss blocks actions and offers reload/resync.
- Retain editor undo/redo, floor/wall/carpet tools, furniture rotation, layout import/export, zoom, pixel scaling, sound, labels, ghost agents, intro/consent flow, changelog and version indicator.
- Restrict browser mock entrypoints and test hooks to test builds; shipped code must fail visibly if the desktop bridge is missing instead of silently showing fake agents.

### Native services

Wrap `Utils.openFileDialog` for a single directory (`canChooseFiles:false`, `canChooseDirectory:true`, `allowsMultipleSelection:false`). Treat an empty result as cancellation; require an existing absolute directory, canonicalize it and check access. Use native file dialogs for JSON layout import/export with explicit overwrite confirmation. Opening folders uses `Utils.openPath` on host-derived paths. [Native utility APIs](https://framework.blackboard.sh/electrobun/apis/utils/)

Provide File/Application menu actions for Settings, Import/Export Layout, Sessions by provider, Logs, Diagnostics, Check for Updates and Quit. Add reload and devtools only in development/debug builds. Map platform-appropriate Cmd/Ctrl shortcuts without swallowing text input or editor shortcuts. Use local menu action IDs mapped to fixed handlers, not executable strings.

Window defaults: 1280x800, minimum 800x600. Persist normal bounds plus maximized state after a 250 ms debounce. Validate finite values and clamp restored bounds to a connected display; test monitor removal, DPI/scale changes and negative monitor coordinates. Native startup errors include a log-folder action. Log rotation: five files of at most 5 MiB, redact tokens/prompts/transcripts, and include app/runtime/platform/instance/operation correlation metadata.

## 10. Versioned persistence and migration transaction

### Desktop profile

```text
~/.pixel-agents/
  desktop/
    config.json          schemaVersion, settings, workspaces, provider preferences
    state.json           schemaVersion, agents, stable seats, dismissals, retained sessions
    layout.json          schemaVersion, layoutRevision, full layout DTO
    window.json          schemaVersion, bounds/maximized
    migration.json       completion marker, source paths/hashes, backup manifest
    instance.lock        ephemeral owner metadata
    logs/
    backups/<migration-id>/
  hooks/desktop/...      immutable helper versions, outside app installation
  servers/...           hook compatibility registrations
```

Desktop becomes the sole writer to its own config/state/layout. Copy shared legacy hook preferences/consent at migration, then use a desktop repository implementation injected into consent/provider services. Do not keep calling global `readConfig()` after migration. Legacy builds may coexist during development but do not synchronize desktop settings bidirectionally; document that running them can change shared provider hook files. Both installers must preserve unrelated/other-version entries until final cutover tests confirm ownership cleanup.

Define schema version 1 with `ProviderId`, canonical session-key records and complete layout validation. Settings include current adapter fields, external directories, per-provider hook consent/preference, provider executable overrides and workspace list. State includes agent identity/provider/transcript/cwd, visual metadata, team restoration fields, retained status and dismissed session keys. Never persist child handles, live PIDs as authority, timers or runtime tokens in these files.

### First-run migration algorithm

1. Under the profile lock, if a valid completion marker and valid desktop files exist, skip import. An unsupported newer schema opens recovery guidance without writing.
2. Read source bytes and parse each independently; record existence, checksums and validation failures. Choose raw standalone settings if present, otherwise raw VS Code settings, otherwise defaults. Select standalone state if present, otherwise VS Code state; a corrupt preferred file triggers recovery/import choice rather than silent fallback.
3. Copy source bytes to a uniquely named backup directory. A failed backup aborts migration before any destination replacement. Record an in-progress journal before staging desktop files.
4. Transform agents using provider metadata and known transcript root/parser evidence. Do not infer provider from numeric IDs. Ambiguous records are preserved in a recovery list and excluded from live restoration until resolved.
5. Remap each selected source numeric seat key through its agent record into a provider-qualified session key; preserve palette/hue/seat ID. Duplicate seat claims use deterministic source order, with displaced agents unseated. Keep unmatched records in migration diagnostics/backup.
6. Old unqualified dismissed IDs must continue suppressing discovery. Resolve them to known provider identities where possible; otherwise retain a legacy-ID tombstone checked by both providers until explicit re-employment clears the relevant legacy record. Never drop an unresolved dismissal.
7. Validate full layout including current editor extensions and asset references. Preserve missing external-asset references with a visible warning/fallback; do not reset the layout. Import shared external directories/consent/preferences without converting unanswered consent into granted.
8. Write validated staged files with unique same-directory temporary names, flush/close, then rename. Publish `migration.json` completion last, including schema versions and source hashes. No scans or normal writes begin before this point.
9. On interrupted migration, use the journal to finish a fully validated stage or restore the previous desktop generation; never merge partial generations. Original sources/backups stay intact. Repeat execution must produce identical logical data and no duplicate hook entries.

All subsequent writes go through one asynchronous serialized repository per profile. Use revision checks for concurrent UI saves, unique temp names, fsync where supported, atomic replacement and bounded Windows sharing-violation retries. Propagate ENOSPC/EACCES/rename errors; acknowledge save only after durable success. Debounce high-frequency seats/window changes and flush them on shutdown. Own-write layout notifications use content/revision comparison instead of a single skip-next-event boolean.

Reset requires a native confirmation naming the chosen scope and creates a recoverable backup. Resetting layout/settings/visual state must not silently revoke or grant provider hook consent, erase transcripts or uninstall CLIs. New bundled defaults apply only to a new/reset profile, never automatically over an existing customized layout.

## 11. Validation strategy

Record the baseline before adding desktop code: `npm run check-types`, `npm run lint`, `npm test`, `npm run build:webview`, and representative legacy E2E workflows. Current uncommitted work may already fail a gate; capture exact failures and distinguish them from migration regressions. Do not edit unrelated code simply to make a baseline green.

| Layer              | Required assertions                                                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime regression | Existing agentRuntime, parsers, hookEventHandler, team/background agents, activity resend, names, conversation, dismissal and palette tests remain meaningful                               |
| Provider isolation | Same session ID/tool ID in two providers cannot collide; scans/events/preferences route correctly; mixed Claude/Codex agents render correctly                                               |
| Process supervisor | Spawn failure, nonzero exit, timeout, cancellation, descendant cleanup, missing CLI, GUI PATH, Windows shim, same-session contention, rapid launch correlation                              |
| Hook HTTP/helper   | Invalid auth/provider/body/Host/Origin, unavailable desktop, fan-out, stale records, helper path quoting, no Node on PATH, idempotent install/uninstall preserving third-party entries      |
| RPC                | Every request validates params and result/error behavior; invalid IDs/paths/layouts, version conflicts, duplicate request IDs, stale epochs, no retry double-spawn                          |
| Snapshot/events    | Event during bootstrap, complete active-tool snapshot, duplicates/gaps/overflow, renderer reload/unmount, no leaked subscribers and no duplicate characters                                 |
| Persistence        | Both namespace sources, missing/corrupt files, unknown schema, ambiguous provider, old dismissals, remapped seats, crash at each commit boundary, ENOSPC, restart idempotence               |
| Renderer           | Office/editor parity, catalog hydration order, initial history bottom, pagination scroll, late history response, prompt failure draft retention, capability gating, areas/pets/team/context |
| Native wrappers    | Folder cancel/nonexistent/relative/symlink result, export cancel, overwritten file guard, window restore off-screen, shutdown prompt cancellation                                           |
| Packaged app       | Real CEF and `views://`, packaged assets/helper, RPC request/event, fixture hooks, app restart persistence, second-instance focus, no orphan children or listeners                          |
| Update             | Version N -> N+1 -> relaunch, profile preserved, helper migration, failed/offline download, integrity failure, busy-turn restart cancellation, recoverable rollback                         |

### Test isolation and desktop smoke harness

Every fixture uses `mkdtemp` profiles and injected provider roots/settings paths; no test may install hooks into the developer's actual home. Update old tests that mock `os.homedir` to use injectable paths incrementally. Fixture CLIs mimic version probes, output, hook events, writer locks, long-running descendants and failure exits without network inference.

Do not assume Playwright's Electron launcher supports Electrobun. In Phase 0, verify whether the pinned CEF exposes usable loopback CDP under test-only flags. If available, use Playwright CDP against the real CEF renderer. Otherwise build a test-only in-app runner that exercises the real RPC/DOM and writes structured results/screenshots to the temporary profile; continue Playwright browser tests for the renderer mock separately. Packaged smoke must still exercise the actual native app, never only Vite/browser fixtures. Production artifacts exclude CDP flags, test RPC methods and fixture providers.

The smoke runner launches a built executable from outside the repo, waits for a bounded ready signal, verifies app/renderer versions and URL, injects both providers' fixture hooks through the actual helper, observes characters/tool states, sends a managed prompt, saves layout/seats, restarts and checks persistence, then quits and checks process/listener cleanup. Collect native logs, result JSON and a screenshot on failure. Linux CI requires a display session (Xvfb for X11 plus separate Wayland coverage); macOS/Windows need a usable GUI session.

Real-provider acceptance is a separate opt-in manual check with test accounts/workspaces: authenticate CLIs, open external sessions, verify activity/history, complete an external turn and safely resume, test Claude team/subagent activity, Codex writer exclusion and one-shot retention. Record exact provider CLI versions. Fake provider tests do not prove real CLI compatibility.

### Required final commands

```text
npm ci
npm run desktop:prepare
npm run check-types
npm run check-types:desktop
npm run lint
npm test
npm run test:desktop
npm run desktop:build
npm run verify:desktop-package -- --artifact <native-artifact>
npm run test:desktop:smoke -- --artifact <native-artifact>
```

Update final `check-types`, lint, format, knip, test/report and inventory scripts to include desktop/core contracts and exclude deleted adapters. Unit tests on Node do not substitute for runtime/packaged compatibility checks. Retain Allure reporting where useful; failures in optional report hosting must not hide or override required native gates.

## 12. Packaging, signing, updates and operations

Create `.github/workflows/desktop-ci.yml` with shared static/unit jobs and native target build/smoke jobs. Cache npm and pinned SDK/CEF downloads by lockfile/toolchain/platform; build from source on each native runner. Keep provider secrets out of PR jobs. Upload logs/screenshots/build manifests with target and version in filenames.

Create `.github/workflows/publish-desktop.yml` with tag/version agreement, commit provenance, native build/test, signing and final artifact verification before release publication. Confirm signing identity, supported targets and update-host ownership before enabling the publishing job. These are deployment inputs, not reasons to stop local implementation.

Each distributable must contain CEF libraries/helpers/resources/locales, selected main runtime, bundled renderer/assets, target hook helper and third-party licenses. Verify launch from a clean user account without Node/Bun/Hutch/VS Code installed and with no repository nearby. Linux dependency checks must run against the documented baseline. Generate macOS and Windows icons from `icon.png` and retain the source/license.

Sign/notarize macOS app and embedded executable helpers with the release identity and required entitlements; verify the installed app passes OS assessment. Sign/timestamp Windows app/helper/distribution as appropriate, and verify signatures after packaging. Linux ships checksums and signed release metadata. Record actual archive/installer formats emitted by the pinned toolchain rather than promising an unsupported MSI/DMG/AppImage format. Test installation paths containing spaces/non-ASCII characters and moving the installed application.

Wrap Electrobun `Updater` in a host-owned service with states `idle/checking/available/downloading/ready/applying/error`. Publish those states through RPC, preserve actionable errors, and block application restart until owned turns are finished/cancelled and persistence is flushed. Follow the selected release's manifest/artifact naming and update API; configuration and SDK examples must be verified against the pinned version. [Updater API](https://framework.blackboard.sh/electrobun/apis/updater/)

Publish immutable versioned artifacts first, verify checksums/signatures and downloadability, then advance channel metadata. Keep stable and canary profiles/channels separated during testing; never let canary automatically overwrite stable data. Use HTTPS update metadata from a fixed trusted origin. Validate the pinned updater's integrity/signature guarantees; if it cannot meet the required artifact-authenticity policy, ship manual signed-download updates until verification is implemented. Do not claim a checksum alone authenticates an update.

Test an actual N-to-N+1 upgrade, including helper switching and schema compatibility. Retain the previous helper and pre-migration backup. On failure restore channel metadata to the last good version and provide a signed previous installer; older apps must reject newer schema versions without overwriting them. Update archives must not contain user data or replace the stable profile root.

## 13. Ordered work packages and completion tracking

Progress is measured by exit criteria, not document length or unchecked feature claims. Each package should be independently reviewable. Do not begin deleting legacy functionality before desktop replacement gates pass.

| Phase / work package            | Dependencies             | Deliverables                                                                                                | Exit gate                                                                                              | Status |
| ------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------ |
| P0 Baseline and compatibility   | None                     | Baseline report, target matrix, exact toolchain pin, runtime/CEF/helper/process/CDP spikes                  | Reproducible packaged fixture app on candidate targets; unresolved target failures explicitly recorded | [ ]    |
| P1 Desktop skeleton/build       | P0 runtime choice        | Configs, SDK aliases, scripts, resources, CEF window, logging/error boundary                                | Dev and packaged UI load `views://`, prove CEF and clean quit outside repo                             | [ ]    |
| P2 Persistence foundation       | P0 source inventory      | Injected paths, validators, profile repository, migration journal/backups                                   | Migration/failure/idempotence fixtures pass; legacy sources untouched                                  | [ ]    |
| P3 Runtime extraction/lifecycle | P1, P2                   | runtimeHost, commands, hook-only listener, lock/registry, awaited stop                                      | Headless fixture host start/stop, partial failure rollback, no leaks/reuse of legacy server            | [ ]    |
| P4 Providers/processes/helper   | P3                       | Both providers, qualified identity, managed turns, CLI detection, stable native helper, consent integration | Mixed-provider/writer/retention/cancellation/install tests and real-provider smoke pass                | [ ]    |
| P5 RPC and snapshot bridge      | P3, domain types from P4 | Complete validated request/event contract, snapshot projection, subscriptions, deduplication                | Ordering/race/error/timeout tests; actual CEF request/event round trip                                 | [ ]    |
| P6 Renderer/native parity       | P4, P5                   | DesktopClient, reducer, history, editor/settings/assets, folders/menus/window state                         | UI action matrix and actual desktop smoke pass, no application WebSocket calls                         | [ ]    |
| P7 Cross-platform hardening     | P1–P6                    | Native CI, packaged tests, redacted diagnostics, startup/recovery docs                                      | Every declared supported target passes clean-profile and upgraded-profile gates                        | [ ]    |
| P8 Release/update pipeline      | P7                       | Signing, verified installers/archives, channel hosting, update/rollback test                                | Signed N -> N+1 upgrade and busy-turn/data/helper checks pass                                          | [ ]    |
| P9 Legacy removal/cutover       | P6–P8                    | Deleted adapters/transports/build/publish paths; final docs and package contract                            | Clean checkout builds/tests desktop only; dependency/reference audit passes                            | [ ]    |

P2 and pure contract design can proceed after the baseline while the skeleton is developed, but implementation must use the resolved runtime/resource assumptions. Keep each phase's tests with its code; P7 is cross-platform verification, not the first testing phase.

Update the following block at the end of every implementation session:

```text
Last updated: 2026-09-21
Current phase: P1-P6 substantially implemented and verified on Linux x64; no phase exit gate is fully met
Completed (Linux x64, dev + stable builds): Cottontail/CEF packaged app loading views://; typed RPC + revisioned events with a DOM-free renderer state reducer; bundled + external asset catalog served in hashed chunks (office renders); Bun-compiled standalone hook helper; journaled/rollback-safe migration with backups, schema guards and crash-injection tests; durable atomic writes; consent gate/executor over the desktop profile (install/notNow/never, revisable); provider-qualified sessions, discovery with eligibility, Codex launch correlation, re-employment; process-tree supervision and awaited shutdown; rotating redacted logs, persisted/clamped window bounds, startup-error dialog; updater state machine; packaged-app smoke (24 checks over real CEF via CDP) and a production smoke asserting no DevTools port; Linux x64 desktop CI workflow
In progress / not started: typed DesktopClient replacing the legacy-message adapter in the React tree (DesktopTransport remains a compatibility layer); conversation-drawer/history parity checks in the packaged UI; native menus, provider-executable chooser, external asset directory picker, layout import/export dialogs, diagnostics export; reset flows
Blocked by inputs not available here: macOS/Windows/Linux ARM builds and CEF evidence; signing and notarization; owned HTTPS update origin and update authenticity; real provider CLI acceptance; a real N -> N+1 upgrade
Legacy removal (section 14): intentionally NOT started - it is gated on parity and cross-platform evidence that does not yet exist
Verification: check-types, lint (only the pre-existing App.tsx warning), test:desktop (109 tests), test:webview (109 tests), check-types:desktop, verify:desktop-package (dev dir and stable update archive), test:desktop:smoke (24 checks) and the production smoke pass locally on Linux x64. The broad legacy test suite was not re-baselined as green.
Next: typed DesktopClient migration; remaining native dialogs/menus; run the CI workflow on a real runner; then per-target native evidence before any publish or removal work
```

### Release inputs that must be resolved before publication

- Exact tested SDK/runtime/CEF/provider versions and minimum OS support (P0/P7 evidence).
- Availability of native ARM runners and CEF artifacts for every advertised target.
- Final reverse-DNS app identifier, signing accounts/certificates and notarization credentials.
- Owned HTTPS update origin/channel storage and the artifact-authenticity mechanism.
- Final release version, installer formats and release notes describing browser/extension retirement.

Record decisions in `docs/desktop/toolchain.md` and `docs/desktop/releasing.md` as each gate supplies evidence. Do not invent version numbers, credentials or a production update URL in code.

## 14. Legacy removal checklist

- [ ] Remove `adapters/vscode/`, VS Code terminal/activation/uninstall code, `.vscode` extension debug tasks and VSIX-specific fixtures/tests after equivalent behavior has desktop coverage.
- [ ] Remove root `engines.vscode`, `extensionKind`, `activationEvents`, `contributes`, extension `main`, old CLI `bin`, VS Code publisher/category metadata and VSIX/npm application `files` entries. Make the desktop root package private; retain license/repository/version metadata.
- [ ] Remove `server/src/cli.ts` and the combined `server.ts`/`httpServer.ts` implementation once new hook server/registry modules own all retained behavior. Remove the old WebSocket message handler after its services are migrated.
- [ ] Remove `PostMessageTransport`, `WebSocketTransport`, `acquireVsCodeApi`, query-token handling, browser runtime branches and browser mock asset middleware from production paths. Keep explicitly isolated renderer test mocks.
- [ ] Remove `@fastify/static`, `@fastify/websocket`, `@fastify/cors`, direct `ws`/types, `@types/vscode` and `@vscode/test-electron` where no retained test/tool depends on them. Regenerate the npm lockfile normally; do not blindly delete transitive networking libraries used by unrelated tooling.
- [ ] Replace generated UI contract imports, then remove `core/asyncapi.yaml`, `core/src/messages.ts`, generator/validator scripts and AsyncAPI dependencies if no retained hook documentation consumer needs them. The typed desktop contract and validators become authoritative.
- [ ] Rewrite `esbuild.js` into the retained asset/helper preparation paths; remove extension/CLI/uninstall outputs. Update tsconfig, ESLint import rules, prettier, lint-staged, knip, scripts and root/server workspace naming metadata as needed.
- [ ] Replace extension/npm package-contract tests and verification/publishing scripts with desktop artifact checks. Remove obsolete browser/VS Code E2E launcher fixtures and update inventory/report generation.
- [ ] Replace `.github/workflows/publish-extension.yml` and old CI extension/browser jobs only after desktop publication has been dry-run successfully. Audit README, CONTRIBUTING, CHANGELOG, SECURITY, CONTEXT, CLAUDE, docs/provider/external-assets guides, e2e docs and environment examples.
- [ ] Audit `vercel.json` and report assembly separately: hosted Allure reports are not the retired browser product and may remain if still used.
- [ ] Use `rg` over source/config/scripts/docs to inspect remaining `vscode`, `/ws`, `WebSocketTransport`, `acquireVsCodeApi`, `dist/webview`, `dist/cli`, `asyncapi` and `PIXEL_AGENTS_PROVIDER` references. Classify legitimate history/framework references; do not require zero textual mentions.
- [ ] Build from a clean checkout, verify generated files are not required from an old `dist/`, and prove both providers from the final packaged artifact.

## 15. Definition of done

The migration is complete only when a clean checkout builds the declared signed/installable desktop targets; the real renderer is CEF loading packaged assets; every UI action uses the typed desktop client; custom browser/VS Code transports and application publishing paths are removed; both providers work with safe writer/process ownership; existing user data migrates without layout resets or lost dismissals/seats; updates and crashes leave recoverable data; and automated plus real-provider packaged acceptance checks pass with recorded evidence.

The app must report missing CLIs, hook installation failures, busy sessions, failed saves and startup/update errors through usable UI/diagnostics. Passing a window-launch test alone does not satisfy the migration.

## References and verification policy

Upstream APIs were reviewed on 2026-09-19. The following are living documentation, not proof that a particular release passes this repository's compatibility gate. Pin the implementation to tested releases and link immutable source revisions in the toolchain record.

- [Electrobun overview](https://github.com/blackboardsh/electrobun/blob/main/docs/src/content/docs/electrobun/guides/what-is-electrobun.mdx)
- [Hello World and packaged view paths](https://github.com/blackboardsh/electrobun/blob/main/docs/src/content/docs/electrobun/guides/hello-world.mdx)
- [Hutch and npm delegation](https://framework.blackboard.sh/electrobun/guides/hutch/)
- [Build configuration](https://framework.blackboard.sh/electrobun/apis/cli/build-configuration/)
- [Bundling CEF](https://framework.blackboard.sh/electrobun/apis/bundling-cef/)
- [BrowserView/RPC](https://github.com/blackboardsh/electrobun/blob/main/docs/src/content/docs/electrobun/apis/browser-view.mdx)
- [Electroview](https://framework.blackboard.sh/electrobun/apis/browser/electroview-class/)
- [Platform support and dependencies](https://github.com/blackboardsh/electrobun/blob/main/docs/src/content/docs/electrobun/guides/cross-platform-development.mdx)
- [Native utilities](https://framework.blackboard.sh/electrobun/apis/utils/)
- [Updater](https://framework.blackboard.sh/electrobun/apis/updater/)
