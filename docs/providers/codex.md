# Codex provider

Pixel Agents supports Codex CLI through Codex command hooks. Select it per
host process with:

```bash
PIXEL_AGENTS_PROVIDER=codex npx pixel-agents
```

For the VS Code extension, add the same environment variable to the
environment used to launch VS Code, then reload the window.

## Supported mapping

| Codex hook | Pixel Agents event |
| --- | --- |
| `SessionStart` | `sessionStart` |
| `SessionEnd` | `sessionEnd` |
| `PreToolUse` | `toolStart` |
| `PostToolUse` | `toolEnd` |
| `PermissionRequest` | `permissionRequest` |
| `Stop` | `turnEnd` / Done |
| `Interrupt` | `turnEnd` / Waiting for input |
| `SubagentStart` | Basic subagent start |
| `SubagentStop` | Basic subagent end |

After consent, Pixel Agents installs command entries in `~/.codex/hooks.json`
and copies the forwarder to `~/.pixel-agents/hooks/codex-hook.js`. Existing
Codex hooks are retained; malformed configuration is not rewritten.

Codex transcript files are used opportunistically. Their format is not treated
as a stable public interface, so live hook events are authoritative. Codex
teams are not represented yet; basic subagent lifecycle events are supported.
The default provider remains Claude for backward compatibility.
