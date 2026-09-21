import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpHome: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpHome };
});

const {
  areHooksInstalled,
  hasDesktopHelperCommands,
  hasOutdatedHandlerSettings,
  hasLegacyHookCommands,
  hookScriptPath,
  installHooks,
  isHookScriptStale,
  refreshHookScript,
  uninstallHooks,
} = await import('../src/providers/hook/codex/codexHookInstaller.js');

function configPath(): string {
  return path.join(tmpHome, '.codex', 'hooks.json');
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(configPath(), 'utf8')) as Record<string, unknown>;
}

describe('codexHookInstaller', () => {
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-codex-hook-'));
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('tells the old Node-script entries from the desktop helper, and an install replaces them', async () => {
    const legacy = `node "${path.join(tmpHome, '.pixel-agents', 'hooks', 'codex-hook.js')}"`;
    const helper = `"${path.join(tmpHome, '.pixel-agents', 'hooks', 'desktop', '1.0.0', 'linux-x64', 'pixel-agents-hook')}" --provider codex`;
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    const write = (command: string) =>
      fs.writeFileSync(
        configPath(),
        JSON.stringify({
          hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command }] }] },
        }),
      );
    expect(hasLegacyHookCommands()).toBe(false); // nothing installed yet
    write(legacy);
    expect(areHooksInstalled()).toBe(true);
    expect(hasLegacyHookCommands()).toBe(true);
    write(helper);
    expect(areHooksInstalled()).toBe(true);
    expect(hasLegacyHookCommands()).toBe(false);
    // A third party's node script is not ours and never counts as legacy.
    fs.writeFileSync(
      configPath(),
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node /other.js' }] }] },
      }),
    );
    expect(hasLegacyHookCommands()).toBe(false);
    // Installing the helper over old entries removes the old form.
    write(legacy);
    await installHooks(helper);
    expect(hasLegacyHookCommands()).toBe(false);
    expect(areHooksInstalled()).toBe(true);
  });

  it('the desktop keeps Codex on the reviewed script form and refreshes the script behind it', async () => {
    const helper = `"${path.join(tmpHome, '.pixel-agents', 'hooks', 'desktop', '1.0.0', 'linux-x64', 'pixel-agents-hook')}" --provider codex`;
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    const source = path.join(tmpHome, 'packaged-codex-hook.js');
    fs.writeFileSync(source, '// current script that forwards to the desktop app');

    // The helper form is detected (it is what a Codex review would reject after an update)...
    await installHooks(helper);
    expect(hasDesktopHelperCommands()).toBe(true);

    // ...and installing the script form replaces it with EXACTLY the definition users approved.
    await installHooks();
    expect(hasDesktopHelperCommands()).toBe(false);
    const entry = (readConfig().hooks as Record<string, Array<Record<string, unknown>>>)
      .PreToolUse![0]!;
    expect(entry).toEqual({
      matcher: '',
      hooks: [{ type: 'command', command: `node "${hookScriptPath()}"`, timeout: 5, async: true }],
    });

    // The script file is refreshed without touching hooks.json, so approval is not lost.
    const before = fs.readFileSync(configPath(), 'utf8');
    expect(isHookScriptStale(source)).toBe(true); // nothing installed yet
    expect(refreshHookScript(source)).toBe(true);
    expect(fs.readFileSync(hookScriptPath(), 'utf8')).toContain('forwards to the desktop app');
    expect(isHookScriptStale(source)).toBe(false);
    expect(fs.statSync(hookScriptPath()).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(configPath(), 'utf8')).toBe(before);
    // Idempotent, and a missing source is reported instead of clobbering the script.
    expect(refreshHookScript(source)).toBe(true);
    expect(refreshHookScript(path.join(tmpHome, 'missing.js'))).toBe(false);
    expect(fs.readFileSync(hookScriptPath(), 'utf8')).toContain('forwards to the desktop app');
  });

  it('declares the limits Codex enforces, so it stops warning at every start', async () => {
    await installHooks();
    const hooks = readConfig().hooks as Record<
      string,
      Array<{ hooks: Array<Record<string, unknown>> }>
    >;
    const handler = (event: string) => hooks[event]![0]!.hooks[0]!;
    // Codex: "clamping SessionEnd hook timeout to 3s", "running async SessionEnd hook synchronously",
    // "clamping Interrupt hook timeout to 3s".
    expect(handler('SessionEnd')).toMatchObject({ timeout: 3 });
    expect('async' in handler('SessionEnd')).toBe(false);
    expect(handler('Interrupt')).toMatchObject({ timeout: 3, async: true });
    for (const event of ['SessionStart', 'Stop', 'PreToolUse', 'PostToolUse', 'PermissionRequest'])
      expect(handler(event)).toMatchObject({ timeout: 5, async: true });
    expect(hasOutdatedHandlerSettings()).toBe(false);
  });

  it('spots entries written with the old uniform settings, and a reinstall repairs them', async () => {
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    const command = `node "${hookScriptPath()}"`;
    const old = { matcher: '', hooks: [{ type: 'command', command, timeout: 5, async: true }] };
    fs.writeFileSync(
      configPath(),
      JSON.stringify({ hooks: { SessionEnd: [old], Interrupt: [old], Stop: [old] } }),
    );
    expect(hasOutdatedHandlerSettings()).toBe(true);
    await installHooks();
    expect(hasOutdatedHandlerSettings()).toBe(false);
    // A third party's entry with unusual settings is never "ours" and never rewritten.
    fs.writeFileSync(
      configPath(),
      JSON.stringify({
        hooks: {
          SessionEnd: [{ hooks: [{ type: 'command', command: 'node /other.js', timeout: 60 }] }],
        },
      }),
    );
    expect(hasOutdatedHandlerSettings()).toBe(false);
  });

  it('installs idempotent entries while retaining third-party hooks', async () => {
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    fs.writeFileSync(
      configPath(),
      JSON.stringify({
        hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'node /other.js' }] }] },
      }),
    );
    await installHooks();
    await installHooks();
    const config = readConfig();
    const stop = (config.hooks as Record<string, unknown[]>).Stop as Array<{ hooks: unknown[] }>;
    expect(stop).toHaveLength(2);
    expect(stop[0].hooks).toEqual([{ type: 'command', command: 'node /other.js' }]);
    expect(areHooksInstalled()).toBe(true);
  });

  it('removes only Pixel Agents hooks', async () => {
    await installHooks();
    const config = readConfig();
    (config.hooks as Record<string, unknown[]>).Stop = [
      {
        matcher: '',
        hooks: [
          { type: 'command', command: 'node /other.js' },
          ...((config.hooks as Record<string, Array<{ hooks: unknown[] }>>).Stop[0].hooks ?? []),
        ],
      },
    ];
    fs.writeFileSync(configPath(), JSON.stringify(config));
    await uninstallHooks();
    const after = readConfig();
    expect(areHooksInstalled()).toBe(false);
    expect((after.hooks as Record<string, Array<{ hooks: unknown[] }>>).Stop[0].hooks).toEqual([
      { type: 'command', command: 'node /other.js' },
    ]);
  });

  it('refuses malformed JSON instead of overwriting it', async () => {
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    fs.writeFileSync(configPath(), '{not-json');
    await expect(installHooks()).rejects.toThrow("Couldn't parse ~/.codex/hooks.json");
    expect(fs.readFileSync(configPath(), 'utf8')).toBe('{not-json');
  });
});
