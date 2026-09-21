import { spawnSync } from 'node:child_process';
import * as os from 'node:os';

import { describe, expect, it } from 'vitest';

import { ProcessSupervisor } from '../src/processSupervisor.js';

const runningSleepers = (marker: string) =>
  spawnSync('pgrep', ['-f', `^sleep ${marker}$`], { encoding: 'utf8' })
    .stdout.split('\n')
    .filter(Boolean);
const waitUntil = async (condition: () => boolean, timeoutMs = 3_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
};

describe.skipIf(process.platform === 'win32')('ProcessSupervisor descendant cleanup', () => {
  it('terminates the whole process tree when an operation is cancelled or the supervisor stops', async () => {
    const supervisor = new ProcessSupervisor();
    supervisor.spawn({
      providerId: 'claude',
      cwd: os.tmpdir(),
      executable: '/bin/sh',
      args: ['-c', 'sleep 4117 & wait'],
    });
    await waitUntil(() => runningSleepers('4117').length > 0);
    expect(runningSleepers('4117').length).toBeGreaterThan(0);
    await supervisor.stop(1_000, 1_000);
    await waitUntil(() => runningSleepers('4117').length === 0);
    expect(runningSleepers('4117')).toEqual([]);
  });

  it('sweeps helpers a provider left behind after its own turn finished', async () => {
    const supervisor = new ProcessSupervisor();
    const operation = supervisor.spawn({
      providerId: 'codex',
      cwd: os.tmpdir(),
      executable: '/bin/sh',
      args: ['-c', 'sleep 4118 & sleep 0.2; exit 0'],
    });
    await waitUntil(() => operation.state === 'completed');
    await waitUntil(() => runningSleepers('4118').length === 0);
    expect(operation.state).toBe('completed');
    expect(runningSleepers('4118')).toEqual([]);
  });
});

describe('ProcessSupervisor', () => {
  it('serializes turns by provider-qualified session and releases the lock after cancellation', async () => {
    const supervisor = new ProcessSupervisor();
    const operation = supervisor.spawn({
      providerId: 'claude',
      sessionKey: { providerId: 'claude', sessionId: 'shared-id' },
      cwd: os.tmpdir(),
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
    });

    expect(() =>
      supervisor.spawn({
        providerId: 'claude',
        sessionKey: { providerId: 'claude', sessionId: 'shared-id' },
        cwd: os.tmpdir(),
        executable: process.execPath,
        args: ['-e', 'process.exit(0)'],
      }),
    ).toThrow('SESSION_BUSY');

    supervisor.cancel(operation.operationId);
    await supervisor.stop(250, 250);
    expect(supervisor.get(operation.operationId)?.state).toBe('cancelled');
  });

  it('tracks a completed owned process', async () => {
    const supervisor = new ProcessSupervisor();
    const operation = supervisor.spawn({
      providerId: 'codex',
      cwd: os.tmpdir(),
      executable: process.execPath,
      args: ['-e', 'process.exit(0)'],
    });
    await new Promise<void>((resolve) => operation.child.once('close', () => resolve()));
    expect(operation.state).toBe('completed');
    expect(operation.exitCode).toBe(0);
    expect(supervisor.operationState(operation).finishedAt).toEqual(expect.any(Number));
  });

  it('does not acknowledge an executable that the OS cannot spawn', async () => {
    const supervisor = new ProcessSupervisor();
    await expect(
      supervisor.spawnAcknowledged({
        providerId: 'codex',
        cwd: os.tmpdir(),
        executable: '/definitely/missing/pixel-agents-provider',
        args: [],
      }),
    ).rejects.toThrow();
  });
});
