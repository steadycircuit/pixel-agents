import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpHome: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpHome };
});

const { areHooksInstalled, hasLegacyHookCommands, installHooks, uninstallHooks } =
  await import('../src/providers/hook/codex/codexHookInstaller.js');

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
