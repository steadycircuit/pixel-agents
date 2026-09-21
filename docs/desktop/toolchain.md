# Desktop toolchain

The desktop target uses the exact `electrobun@2.0.1` npm bootstrap, locked in
`package-lock.json`. Its verified Linux x64 toolchain is Hutch `0.24.3`, Cottontail `0.5.0`,
and Electrobun `2.0.1` with bundled CEF. A development CEF build was produced on Linux
`7.0.0-30-generic` x86_64; this is not yet a cross-platform support promise.

Development uses the repository's Node/npm lockfile. `desktop:prepare` generates the version
metadata consumed by the native package and does not create a second dependency lockfile.

The standalone provider-hook helper is compiled with pinned Bun `1.4.2`. It is a short-lived
native executable packaged at `hooks/pixel-agents-hook`; it accepts a fixed `--provider
claude|codex` argument and does not require Node on the user's PATH. The current verification
is Linux x64 only; each release platform still needs an independently compiled and tested helper.

`hutch.config.ts` explicitly delegates dependency management to npm and pins the matching
Electrobun release. `npm run check-types:desktop` runs the authoritative Cottontail/CEF build:
the generated SDK currently contains Bun-FFI declarations that plain Node `tsc` cannot validate.

## Evidence recorded so far (Linux x64 only)

Host: Linux `7.0.0-30-generic` x86_64 with an X11/Wayland desktop session. Nothing below is a
support promise for another OS, architecture or distribution.

| Check                                                      | Result on Linux x64                                                                                                                                                         |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime                                                    | Cottontail `0.5.0` runs the shared runtime (Fastify loopback listener, fs, child processes, streams) with CEF                                                               |
| CEF + `views://`                                           | Renderer URL is `views://mainview/index.html`; request/response and event round trips exercised by the smoke test                                                           |
| Test observability                                         | **Development** builds expose loopback CDP on `127.0.0.1:9222`; Playwright `connectOverCDP` drives the real page                                                            |
| Production builds                                          | Stable build opens **no** DevTools port (asserted by `smoke-desktop.mjs --production`)                                                                                      |
| Descendant cleanup                                         | Process-group termination; verified in unit tests and in the packaged app (provider children die with the app)                                                              |
| Standalone hook helper                                     | Bun `1.4.2` compile; delivers real hook events to the packaged app with no Node on `PATH`                                                                                   |
| Stable artifacts emitted (`electrobun build --env=stable`) | `linux-x64-PixelAgents-Setup.tar.gz` (self-extracting installer, ~199 MB), `stable-linux-x64-PixelAgents.tar.zst` (update archive, ~197 MB), `stable-linux-x64-update.json` |

The update archive unpacks to the complete application; `verify:desktop-package` accepts it directly
and cross-checks the update manifest. The installer extracts to `~/.local/share/` and creates a
desktop shortcut.

Not yet evidenced: macOS ARM64, Windows x64, Linux ARM64, minimum OS/glibc baselines, Wayland-only
sessions, GPU-less environments, installation paths containing spaces or non-ASCII characters, and
launching from a clean user account with no Node/Bun/VS Code installed.
