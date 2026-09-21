# Desktop migration handoff

Date: 2026-09-20

## Current request and status

The active project request is to implement `ELECTROBUN_MIGRATION_PLAN.md`.
The migration is **not complete**. A substantial Electrobun desktop foundation is implemented and remains uncommitted in the working tree.

The immediate completed slice is standalone provider-hook helper integration:

- Local Bun is `1.4.2` and is intentionally pinned as the build-time compiler for the helper.
- `server/src/providers/hook/desktopHookHelper.ts` is compiled by Bun into a standalone executable; end users do not need Node or Bun on `PATH` for hooks.
- `scripts/build-hook-helper.mjs` rejects any Bun version other than `1.4.2`.
- `scripts/build-desktop-assets.mjs` places the compiled helper in `dist/desktop-hooks/` alongside transitional legacy compatibility hooks.
- `electrobun.config.ts` packages those hooks at `Resources/app/hooks/`.
- Native hook enable/disable calls now use `installDesktopHelper` / existing guarded uninstalls, via typed desktop RPC.
- The helper is copied, checksum-verified, and made executable under `~/.pixel-agents/hooks/desktop/<app-version>/<platform>-<arch>/`; provider config commands reference that quoted immutable copy with `--provider claude|codex`.
- Provider-owned command detection recognizes both legacy Node script commands and the new standalone-helper command layout.

## Important current implementation

- `desktop/src/main.ts`: CEF window, single-instance lock, runtime host startup, native folder picker, native hook configuration service.
- `desktop/src/rpcHandlers.ts`: typed request validation and RPC handlers. `setHooksEnabled` first performs the native provider settings action, then persists the host setting only after success.
- `desktop/src/paths.ts`: resolves packaged resources from `<bundle>/Resources/app` when launched by Electrobun; uses `PIXEL_AGENTS_RESOURCE_DIR` override or data-root fallback for development/tests.
- `server/src/runtimeHost.ts`: host lifecycle, providers, profile persistence, process supervision, hook routing, conversation reads, workspace operations. It now persists provider-specific hook enabled settings.
- `server/src/providers/hook/desktopHelperInstaller.ts`: versioned helper copy/install logic. It has an injected `installProviderHooks` test seam; production uses the actual Claude/Codex settings installers.
- `webview-ui/src/transport/desktopTransport.ts`: transitional legacy-message adapter. It maps `setHooksEnabled` to typed RPC and refreshes the compatibility bootstrap snapshot after a successful change.
- `scripts/verify-desktop-package.mjs`: verifies both staging output and packaged native artifact. Its omitted `--artifact` default was fixed; it now correctly defaults to `dist`.
- `docs/desktop/toolchain.md`: records `electrobun@2.0.1`, Hutch `0.24.3`, Cottontail `0.5.0`, CEF build evidence, and Bun `1.4.2` helper compiler.
- `ELECTROBUN_MIGRATION_PLAN.md`: marked `in progress`, and its end-of-session status block was updated accurately.

## Verification already run

These passed after the latest changes:

- `npm run check-types`
- `npm run test:desktop` — 10 files, 22 tests
- `npm run test:hook-helper` — builds with Bun 1.4.2 and sends a real authenticated loopback hook request
- `npm run check-types:desktop` — prepares metadata/assets, builds renderer, and creates Cottontail/CEF dev package
- `npm run verify:desktop-package`
- `npm run verify:desktop-package -- --artifact build/dev-linux-x64`
- `git diff --check`

`npm run lint` has no errors. It reports one pre-existing warning in `webview-ui/src/App.tsx:221` for a missing `editor` dependency in a React effect; do not change it without a focused request.

The broad legacy `npm test` was previously known to fail in unrelated old Claude-team tests because this environment cannot access `~/.claude`; do not characterize the entire old suite as green.

## Working-tree notes

- The tree is intentionally very dirty: the desktop migration creates many untracked directories/files under `desktop/`, `core/src/desktop/`, `server/src/persistence/`, desktop tests, scripts, and docs.
- Preserve all existing changes; do not reset, checkout, or delete broad paths.
- `bun.lock` is untracked. The plan says npm/package-lock remains authoritative and no second dependency lockfile should be introduced. It may have been created by the user's local Bun update; do not delete it without checking with the user.
- `.hutch`, `build`, `dist`, and `desktop/generated` are intentionally ignored generated output.

## Known remaining gaps (do not claim completion)

- Full renderer migration is unfinished: `DesktopTransport` is a compatibility adapter around legacy messages rather than the final typed desktop client/reducer.
- No complete actual native CEF/RPC smoke harness exists. `scripts/smoke-desktop.mjs` is currently only a profile setup skeleton, not the plan’s required packaged-app exercise.
- Provider transcript/session discovery and reliable Codex new-launch correlation are incomplete; hook events currently create/maintain desktop agents.
- Migration persistence lacks the full journaled transaction/recovery implementation promised by the plan.
- Consent UI semantics (`install` / `notNow` / `never`) are not fully migrated; explicit settings enable currently constitutes consent.
- Native dialogs/settings still lack much of the plan’s requested functionality (provider executable chooser, asset dirs, import/export, diagnostics, update flow, etc.).
- Only Linux x64 has been built/tested. Cross-platform CEF/helper builds, GUI smoke, signing, updates, and real-provider acceptance remain outstanding.
- Legacy VS Code/browser/HTTP-WebSocket code has not been removed; that must wait for parity gates.

## Recommended next work

1. Add real tests around `setHooksEnabled` RPC/native service failure ordering: a failed provider-config write must not persist `hooksEnabled: true`.
2. Replace portions of `DesktopTransport` with a typed renderer client/reducer, preserving full workspace/provider/action behavior.
3. Build a genuine packaged CEF smoke harness that launches the generated executable with a temporary profile and verifies at least one RPC/event round trip.
4. Continue persistence migration hardening: journal/rollback/idempotence and error-injection tests.
5. Add provider discovery/correlation tests before expanding managed launch UI.

## Command notes

- Run native build checks with `npm run check-types:desktop`; it may need permission to use Electrobun/Hutch caches outside the workspace sandbox.
- `npm run test:hook-helper` requires `bun --version` exactly `1.4.2` by design.
- Use `apply_patch` for edits, and use `rg` for searching.
