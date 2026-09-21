import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSingleInstanceLock } from '../../desktop/src/singleInstance.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('desktop single-instance lock', () => {
  it('publishes and owner-conditionally releases a protected registration', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pixel-instance-'));
    roots.push(root);
    const lock = createSingleInstanceLock({
      profileRoot: root,
      instanceId: 'owner-a',
      token: 'secret',
    });
    await expect(lock.acquire()).resolves.toEqual({ primary: true, focusedExisting: false });
    await lock.publish(43123);
    await expect(readFile(path.join(root, 'instance.json'), 'utf8')).resolves.toContain('43123');
    await lock.release();
    await expect(readFile(path.join(root, 'instance.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('focuses a verified existing owner without replacing its lock', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pixel-instance-'));
    roots.push(root);
    const first = createSingleInstanceLock({
      profileRoot: root,
      instanceId: 'owner-a',
      token: 'secret',
    });
    await first.acquire();
    await first.publish(43123);
    const focusOwner = vi.fn(async () => true);
    const second = createSingleInstanceLock({
      profileRoot: root,
      instanceId: 'owner-b',
      token: 'other',
      focusOwner,
    });
    await expect(second.acquire()).resolves.toEqual({ primary: false, focusedExisting: true });
    expect(focusOwner).toHaveBeenCalledWith(expect.objectContaining({ instanceId: 'owner-a' }));
    expect(JSON.parse(await readFile(path.join(root, 'instance.json'), 'utf8'))).toMatchObject({
      instanceId: 'owner-a',
    });
    await first.release();
  });

  it('removes an unverifiable stale owner and acquires the profile', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pixel-instance-'));
    roots.push(root);
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, 'instance.json'),
      JSON.stringify({ pid: 1, instanceId: 'stale', startedAt: 1, port: 43123, token: 'old' }),
      { mode: 0o600 },
    );
    const lock = createSingleInstanceLock({
      profileRoot: root,
      instanceId: 'owner-new',
      token: 'new',
      startupRetries: 0,
      focusOwner: async () => false,
    });
    await expect(lock.acquire()).resolves.toEqual({ primary: true, focusedExisting: false });
    await lock.release();
  });
});
