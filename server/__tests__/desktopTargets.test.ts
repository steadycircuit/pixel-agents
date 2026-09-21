import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readDesktopTarget } from '../src/providers/hook/desktopTargets.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('desktop hook target discovery', () => {
  it('returns a valid live desktop registration', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pixel-target-'));
    roots.push(root);
    const directory = path.join(root, '.pixel-agents', 'desktop');
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, 'instance.json'),
      JSON.stringify({
        pid: process.pid,
        instanceId: 'desktop-a',
        startedAt: Date.now(),
        port: 43123,
        token: 'secret',
      }),
    );
    expect(readDesktopTarget(root)).toMatchObject({
      pid: process.pid,
      port: 43123,
      token: 'secret',
    });
  });

  it('rejects malformed and dead registrations', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pixel-target-'));
    roots.push(root);
    const directory = path.join(root, '.pixel-agents', 'desktop');
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, 'instance.json'),
      JSON.stringify({ pid: 999_999_999, port: 43123, token: 'secret' }),
    );
    expect(readDesktopTarget(root)).toBeUndefined();
  });
});
