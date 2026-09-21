import { describe, expect, it, vi } from 'vitest';

import type { UpdateState } from '../../core/src/desktop/types.js';
import { createUpdateService, type UpdaterPort } from '../../desktop/src/updates.js';

function harness(overrides: Partial<UpdaterPort> = {}, busy = 0) {
  const order: string[] = [];
  const states: UpdateState[] = [];
  const updater: UpdaterPort = {
    configured: async () => true,
    check: async () => ({ available: true, version: '2.0.0' }),
    download: async () => ({ ready: true }),
    apply: async () => {
      order.push('apply');
    },
    ...overrides,
  };
  const service = createUpdateService({
    updater,
    busyTurns: () => busy,
    flush: async () => {
      order.push('flush');
    },
    onChange: (state) => states.push(state),
  });
  return { service, order, states };
}

describe('update service', () => {
  it('walks check -> download -> apply, flushing persistence before the restart', async () => {
    const { service, order, states } = harness();
    expect((await service.run('check')).phase).toBe('available');
    expect((await service.run('download')).phase).toBe('ready');
    await service.run('apply');
    expect(order).toEqual(['flush', 'apply']);
    expect(states.map((s) => s.phase)).toEqual([
      'checking',
      'available',
      'downloading',
      'ready',
      'applying',
      'ready', // apply returning means the restart did not happen
    ]);
    expect(states.at(-1)?.message).toMatch(/did not complete/);
  });

  it('reports a build without an update origin instead of pretending to check', async () => {
    const check = vi.fn();
    const { service } = harness({ configured: async () => false, check });
    const state = await service.run('check');
    expect(state).toMatchObject({ phase: 'error', configured: false });
    expect(state.message).toMatch(/not available/);
    expect(check).not.toHaveBeenCalled();
  });

  it('keeps an actionable message when offline, and can retry', async () => {
    let online = false;
    const { service } = harness({
      check: async () =>
        online
          ? { available: true, version: '2.0.0' }
          : { available: false, error: 'Network is unreachable' },
    });
    expect(await service.run('check')).toMatchObject({
      phase: 'error',
      message: 'Network is unreachable',
    });
    online = true;
    expect((await service.run('check')).phase).toBe('available');
  });

  it('keeps the offered version when a download fails, so the user can retry it', async () => {
    let attempts = 0;
    const { service } = harness({
      download: async () =>
        ++attempts === 1 ? { ready: false, error: 'Integrity check failed' } : { ready: true },
    });
    await service.run('check');
    expect(await service.run('download')).toMatchObject({
      phase: 'error',
      version: '2.0.0',
      message: 'Integrity check failed',
    });
    // The error state is not "available" again until a fresh check.
    expect((await service.run('check')).phase).toBe('available');
    expect((await service.run('download')).phase).toBe('ready');
  });

  it('refuses to restart while owned turns are running and touches nothing', async () => {
    const apply = vi.fn();
    const { service, order } = harness({ apply }, 2);
    await service.run('check');
    await service.run('download');
    const state = await service.run('apply');
    expect(state).toMatchObject({ phase: 'ready', version: '2.0.0' });
    expect(state.message).toMatch(/2 running turns/);
    expect(apply).not.toHaveBeenCalled();
    expect(order).toEqual([]);
  });

  it('will not download or apply out of order', async () => {
    const download = vi.fn();
    const apply = vi.fn();
    const { service } = harness({ download, apply });
    expect((await service.run('download')).message).toMatch(/No update to download/);
    expect((await service.run('apply')).message).toMatch(/No update is ready/);
    expect(download).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('runs one action at a time: a second request joins the one in flight', async () => {
    let release!: () => void;
    const check = vi.fn(
      () =>
        new Promise<{ available: boolean }>(
          (resolve) => (release = () => resolve({ available: false })),
        ),
    );
    const { service } = harness({ check });
    const first = service.run('check');
    const second = service.run('check');
    await vi.waitFor(() => expect(check).toHaveBeenCalled());
    release();
    await Promise.all([first, second]);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('turns an unexpected throw into a visible error state', async () => {
    const { service } = harness({
      check: async () => {
        throw new Error('boom');
      },
    });
    expect(await service.run('check')).toMatchObject({ phase: 'error', message: 'boom' });
  });

  it('rejects an unknown action', async () => {
    await expect(harness().service.run('reinstall' as never)).rejects.toThrow('INVALID_ARGUMENT');
  });
});
