import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  desktopHelperPath,
  installDesktopHelper,
} from '../src/providers/hook/desktopHelperInstaller.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('desktop standalone hook helper installer', () => {
  it('installs a versioned executable before registering its provider command', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pixel-helper-'));
    roots.push(root);
    const source = path.join(root, 'pixel-agents-hook');
    await writeFile(source, 'standalone helper');
    const installProviderHooks = vi.fn(async () => undefined);

    const installed = await installDesktopHelper({
      providerId: 'claude',
      source,
      dataRoot: path.join(root, 'profile'),
      helperVersion: '1.4.1',
      platform: 'linux',
      architecture: 'x64',
      installProviderHooks,
    });

    expect(installed.helperPath).toBe(
      desktopHelperPath({
        dataRoot: path.join(root, 'profile'),
        helperVersion: '1.4.1',
        platform: 'linux',
        architecture: 'x64',
      }),
    );
    expect(await readFile(installed.helperPath, 'utf8')).toBe('standalone helper');
    expect((await stat(installed.helperPath)).mode & 0o777).toBe(0o700);
    expect(installProviderHooks).toHaveBeenCalledWith(
      `"${installed.helperPath}" --provider claude`,
    );
  });
});
