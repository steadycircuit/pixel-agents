# Releasing the desktop app

Status: **not releasable yet.** This records what the pipeline does today, the evidence gathered, and
the inputs that must exist before anything is published. It deliberately invents no version numbers,
credentials or update URLs.

## What the pipeline produces

`npm run desktop:build` runs preparation, asset and helper builds, the renderer build and
`electrobun build --env=stable`. On Linux x64 it emits, under `artifacts/`:

- `linux-x64-PixelAgents-Setup.tar.gz` — self-extracting installer
- `stable-linux-x64-PixelAgents.tar.zst` — full application, used by the updater
- `stable-linux-x64-update.json` — update manifest (`identifier`, `channel`, `version`, `hash`, `artifact.file`)

Verify with `npm run verify:desktop-package -- --artifact artifacts/stable-linux-x64-PixelAgents.tar.zst`
and exercise with `node scripts/smoke-desktop.mjs --production --artifact <unpacked PixelAgents dir>`.
The full behavioural smoke (`npm run test:desktop:smoke`) needs a **development** build because it
observes the renderer over CDP, which production builds intentionally do not expose.

## Continuous integration

`.github/workflows/desktop-ci.yml` runs static checks and unit tests, then a Linux x64 native job:
helper build, CEF build, package verification, the packaged-app smoke (under Xvfb), the stable build,
archive verification and the production smoke. Only Linux x64 is listed because only Linux x64 has
been run end to end. **Add a target only after it has passed the same steps on a native runner.**

There is no publish workflow. Create `.github/workflows/publish-desktop.yml` only once every input in
the next section is resolved, and dry-run it before retiring `publish-extension.yml`.

## Inputs that must be resolved before publication

| Input                                                            | State                                                              |
| ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| Final reverse-DNS app identifier (`com.pixelagents.desktop`)     | Proposed, unconfirmed; changing it later breaks OS/update identity |
| Signing identities: macOS (Developer ID + notarization), Windows | Not available                                                      |
| Owned HTTPS update origin and channel storage                    | Not available; builds report "Updates are not available"           |
| Update authenticity mechanism (signature, not just a checksum)   | Not validated against the pinned updater                           |
| Native ARM runners and CEF artifacts for each advertised target  | Not verified                                                       |
| Release version, installer formats per OS, release notes         | Not decided                                                        |

## Update behaviour (implemented, unverified end to end)

The host wraps Electrobun's `Updater` in a state machine (`idle → checking → available → downloading
→ ready → applying`, `error` from any working state; `desktop/src/updates.ts`). Applying is refused
while owned provider turns are running and only proceeds after window/profile state is flushed. A
build without a configured update origin reports that plainly instead of failing silently.

Not yet tested: a real N → N+1 upgrade, helper switching across versions, integrity/failure
handling against a real origin, and rollback (previous helper and pre-migration backup are retained
by design). Do not claim the update flow works until that has been run.

## Manual acceptance (opt-in, real providers)

Fixture-based tests do not prove real CLI compatibility. Before a release, with test accounts and
workspaces, and recording exact provider CLI versions: authenticate both CLIs; open external
sessions and verify activity and history; complete an external turn and resume it safely; verify
Claude team/subagent activity; verify Codex writer exclusion and one-shot retention; launch twice in
one folder and confirm each launch attaches to its own session.

## App icon

The icon comes from `assets/pixel-agent-logo.png` through `npm run icon` (`scripts/make-icons.mjs`,
deterministic, no extra dependencies). The generated files in `assets/desktop-icons/` are committed;
`desktopIcons.test.ts` fails if they drift from the generator. `electrobun.config.ts` points
`build.linux.icon` and `build.win.icon` at `icon.png` and `build.mac.icons` at `icon.iconset`
(the macOS art is inset to ~80% with a transparent margin).

Electrobun has no per-window icon API, so the icon reaches users through the packaged
`Resources/appIcon.png` and the `Icon=` line of the installed launcher entry. On Linux the dock
matches the window's class (`PixelAgents` in the stable build) to that entry's `StartupWMClass`;
running the app without installing it (or a dev build, whose class is `PixelAgents-dev-dev`) shows a
generic icon.

Verified: byte-identical regeneration; the stable archive and installer contain the icon; a sandboxed
install writes `Icon=<installed appIcon.png>` with a `StartupWMClass` equal to the running window's
class. **Not verified:** the dock rendering itself, the Windows `.ico` conversion, and the macOS
`.icns` (each needs its own OS host).
