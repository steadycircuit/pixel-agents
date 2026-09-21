import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { HOOK_SCRIPTS_DIR } from '../../../constants.js';
import {
  CODEX_HOOK_CONFIG_DIR,
  CODEX_HOOK_CONFIG_NAME,
  CODEX_HOOK_EVENTS,
  CODEX_HOOK_LIMITS,
  CODEX_HOOK_SCRIPT_NAME,
  CODEX_HOOK_TIMEOUT_SECONDS,
  CODEX_SETTINGS_FRESH_FILE_MODE,
  CODEX_SETTINGS_TMP_SUFFIX,
} from './constants.js';

type HookHandler = {
  type: 'command';
  command: string;
  timeout?: number;
  async?: boolean;
};

type HookEntry = { matcher?: string; hooks: HookHandler[] };
type CodexHooksConfig = { hooks?: Record<string, HookEntry[]>; [key: string]: unknown };

export const CODEX_SETTINGS_UNPARSEABLE_MESSAGE = "Couldn't parse ~/.codex/hooks.json";

function settingsPath(): string {
  return path.join(os.homedir(), CODEX_HOOK_CONFIG_DIR, CODEX_HOOK_CONFIG_NAME);
}

function scriptPath(): string {
  return path.join(os.homedir(), HOOK_SCRIPTS_DIR, CODEX_HOOK_SCRIPT_NAME);
}

function ourCommand(): string {
  return `node "${scriptPath()}"`;
}

function isDesktopHelperCommand(command: string): boolean {
  const normalized = command.replace(/\\/g, '/').trim();
  return /^"?.*\/\.pixel-agents\/hooks\/desktop\/[^/]+\/[^/]+\/pixel-agents-hook(?:\.exe)?"?\s+--provider\s+codex$/.test(
    normalized,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isOurHook(value: unknown): value is HookHandler {
  return (
    isRecord(value) &&
    value.type === 'command' &&
    typeof value.command === 'string' &&
    (value.command === ourCommand() || isDesktopHelperCommand(value.command))
  );
}

function readConfig(): { raw: string | null; config: CodexHooksConfig } {
  const file = settingsPath();
  if (!fs.existsSync(file)) return { raw: null, config: {} };
  const raw = fs.readFileSync(file, 'utf8');
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) throw new Error('root is not an object');
    return { raw, config: parsed as CodexHooksConfig };
  } catch (error) {
    throw new Error(CODEX_SETTINGS_UNPARSEABLE_MESSAGE, { cause: error });
  }
}

function cleanEntries(entries: unknown): { entries: HookEntry[]; changed: boolean } {
  if (!Array.isArray(entries)) throw new Error('a Codex hooks event value is not an array');
  let changed = false;
  const next: HookEntry[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || !Array.isArray(entry.hooks)) {
      next.push(entry as HookEntry);
      continue;
    }
    const hooks = entry.hooks.filter((hook) => {
      const remove = isOurHook(hook);
      if (remove) changed = true;
      return !remove;
    });
    if (hooks.length === 0 && entry.hooks.length > 0) {
      changed = true;
      continue;
    }
    next.push({ ...entry, hooks } as HookEntry);
  }
  return { entries: next, changed };
}

function writeConfig(config: CodexHooksConfig, mode?: number): void {
  const file = settingsPath();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = file + CODEX_SETTINGS_TMP_SUFFIX;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', {
    mode: mode ?? CODEX_SETTINGS_FRESH_FILE_MODE,
  });
  fs.renameSync(tmp, file);
}

function mutateConfig(mutator: (config: CodexHooksConfig) => boolean): boolean {
  const { raw, config } = readConfig();
  const changed = mutator(config);
  if (!changed) return false;
  if (raw !== null && fs.readFileSync(settingsPath(), 'utf8') !== raw) {
    throw new Error('~/.codex/hooks.json changed while Pixel Agents was installing hooks');
  }
  const mode = fs.existsSync(settingsPath()) ? fs.statSync(settingsPath()).mode & 0o777 : undefined;
  writeConfig(config, mode);
  return true;
}

export function areHooksInstalled(): boolean {
  try {
    const { config } = readConfig();
    const hooks = config.hooks;
    if (!isRecord(hooks)) return false;
    return Object.values(hooks).some(
      (entries) =>
        Array.isArray(entries) &&
        entries.some(
          (entry) => isRecord(entry) && Array.isArray(entry.hooks) && entry.hooks.some(isOurHook),
        ),
    );
  } catch {
    return false;
  }
}

/**
 * Are any of OUR hook entries the old Node-script form (`node ".../codex-hook.js"`)? That script
 * predates the desktop app and does not forward to it, so the desktop replaces such entries with
 * its standalone helper.
 */
export function hasLegacyHookCommands(): boolean {
  try {
    const { config } = readConfig();
    const hooks = config.hooks;
    if (!isRecord(hooks)) return false;
    return Object.values(hooks).some(
      (entries) =>
        Array.isArray(entries) &&
        entries.some(
          (entry) =>
            isRecord(entry) &&
            Array.isArray(entry.hooks) &&
            entry.hooks.some(
              (hook) =>
                isOurHook(hook) &&
                typeof hook.command === 'string' &&
                !isDesktopHelperCommand(hook.command),
            ),
        ),
    );
  } catch {
    return false;
  }
}

/** The hook definition for one event, honouring Codex's per-event limits. */
function handlerFor(event: (typeof CODEX_HOOK_EVENTS)[number], command: string): HookHandler {
  const limits = CODEX_HOOK_LIMITS[event] ?? { timeout: CODEX_HOOK_TIMEOUT_SECONDS, async: true };
  return {
    type: 'command',
    command,
    timeout: limits.timeout,
    // Omitted entirely for a synchronous handler, exactly as Codex expects it.
    ...(limits.async ? { async: true } : {}),
  };
}

/**
 * Are any of OUR entries set up in a way Codex warns about (a SessionEnd/Interrupt timeout above
 * its 3s cap, or an async SessionEnd)? Such entries are rewritten by the next install.
 */
export function hasOutdatedHandlerSettings(): boolean {
  try {
    const { config } = readConfig();
    const hooks = config.hooks;
    if (!isRecord(hooks)) return false;
    return CODEX_HOOK_EVENTS.some((event) => {
      const entries = hooks[event];
      if (!Array.isArray(entries)) return false;
      return entries.some(
        (entry) =>
          isRecord(entry) &&
          Array.isArray(entry.hooks) &&
          entry.hooks.some((hook) => {
            if (!isOurHook(hook)) return false;
            const wanted = handlerFor(event, String(hook.command));
            return (
              hook.timeout !== wanted.timeout || (hook.async === true) !== (wanted.async === true)
            );
          }),
      );
    });
  } catch {
    return false;
  }
}

export async function installHooks(command = ourCommand()): Promise<void> {
  mutateConfig((config) => {
    if (config.hooks === undefined) config.hooks = {};
    if (!isRecord(config.hooks)) throw new Error('hooks in ~/.codex/hooks.json is not an object');
    let changed = false;
    for (const event of CODEX_HOOK_EVENTS) {
      const existing = config.hooks[event];
      if (existing !== undefined && !Array.isArray(existing)) {
        throw new Error(`hooks.${event} in ~/.codex/hooks.json is not an array`);
      }
      const cleaned = existing ? cleanEntries(existing) : { entries: [], changed: false };
      const next: HookEntry[] = [
        ...cleaned.entries,
        {
          matcher: '',
          hooks: [handlerFor(event, command)],
        },
      ];
      if (JSON.stringify(existing ?? []) !== JSON.stringify(next)) changed = true;
      config.hooks[event] = next;
    }
    return changed;
  });
}

export async function uninstallHooks(): Promise<void> {
  mutateConfig((config) => {
    if (!isRecord(config.hooks)) return false;
    let changed = false;
    for (const event of Object.keys(config.hooks)) {
      const cleaned = cleanEntries(config.hooks[event]);
      if (!cleaned.changed) continue;
      changed = true;
      if (cleaned.entries.length > 0) config.hooks[event] = cleaned.entries;
      else delete config.hooks[event];
    }
    if (Object.keys(config.hooks).length === 0) delete config.hooks;
    return changed;
  });
}

/**
 * Are any of OUR entries the desktop-helper form? Codex only runs a hook it has reviewed, and it
 * tracks approval by the hook's exact definition (`[hooks.state]` trusted_hash in config.toml), so
 * the desktop keeps Codex on the node-script form users already approved. See
 * installCodexScriptHooks in desktopHelperInstaller.ts.
 */
export function hasDesktopHelperCommands(): boolean {
  try {
    const { config } = readConfig();
    const hooks = config.hooks;
    if (!isRecord(hooks)) return false;
    return Object.values(hooks).some(
      (entries) =>
        Array.isArray(entries) &&
        entries.some(
          (entry) =>
            isRecord(entry) &&
            Array.isArray(entry.hooks) &&
            entry.hooks.some(
              (hook) =>
                isRecord(hook) &&
                typeof hook.command === 'string' &&
                isDesktopHelperCommand(hook.command),
            ),
        ),
    );
  } catch {
    return false;
  }
}

/** Where the node-script form of the hook lives (its path is part of the trusted definition). */
export function hookScriptPath(): string {
  return scriptPath();
}

/**
 * Copies `source` over the installed hook script when the content differs. Rewriting the script
 * never changes hooks.json, so a hook the user already approved keeps running the newer code.
 * Returns true when the installed script is current afterwards.
 */
export function refreshHookScript(source: string): boolean {
  const destination = scriptPath();
  try {
    const wanted = fs.readFileSync(source);
    const existing = fs.existsSync(destination) ? fs.readFileSync(destination) : undefined;
    if (existing && existing.equals(wanted)) return true;
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, wanted, { mode: 0o700 });
    fs.renameSync(temporary, destination);
    return true;
  } catch {
    return false;
  }
}

/** True when the installed script differs from (or is missing versus) the packaged one. */
export function isHookScriptStale(source: string): boolean {
  try {
    const destination = scriptPath();
    return (
      !fs.existsSync(destination) || !fs.readFileSync(destination).equals(fs.readFileSync(source))
    );
  } catch {
    return false;
  }
}

export function copyHookScript(extensionPath: string): boolean {
  const source = path.join(extensionPath, 'dist', 'hooks', CODEX_HOOK_SCRIPT_NAME);
  const destination = scriptPath();
  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(source)) return false;
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, 0o700);
    return true;
  } catch {
    return false;
  }
}
