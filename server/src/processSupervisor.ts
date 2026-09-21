import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import type { ProviderId, SessionKey } from '../../core/src/desktop/types.js';
import type { OperationState } from '../../core/src/desktop/types.js';

export interface OwnedProcess {
  operationId: string;
  providerId: ProviderId;
  sessionKey?: SessionKey;
  cwd: string;
  child: ChildProcess;
  state: 'starting' | 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: number;
  finishedAt?: number;
  exitCode?: number | null;
  /** Locks this operation holds; all are released when it ends. */
  lockKeys: string[];
  stdout: string;
  stderr: string;
}
export interface SpawnRequest {
  providerId: ProviderId;
  sessionKey?: SessionKey;
  cwd: string;
  executable: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  /**
   * Serialization key for launches whose session id is not known yet (Codex assigns its own).
   * Defaults to the provider-qualified session key.
   */
  lockKey?: string;
}

/** Terminates a child and every descendant it started. Best effort: the tree may already be gone. */
function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    // Windows has no process groups; taskkill /T walks the tree.
    if (signal === 'SIGKILL' || child.exitCode === null)
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/** Owns every child created by the desktop host. Children are tracked, never orphaned. */
export class ProcessSupervisor extends EventEmitter {
  private readonly processes = new Map<string, OwnedProcess>();
  private readonly sessionLocks = new Set<string>();

  spawn(request: SpawnRequest): OwnedProcess {
    const lock =
      request.lockKey ??
      (request.sessionKey
        ? `${request.sessionKey.providerId}:${request.sessionKey.sessionId}`
        : undefined);
    if (lock && this.sessionLocks.has(lock)) throw new Error('SESSION_BUSY');
    const operationId = randomUUID();
    const child = spawn(request.executable, request.args, {
      cwd: request.cwd,
      env: request.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      // POSIX: the child leads its own process group so the whole tree can be signalled. The
      // handle is retained and never unref'd, so ownership stays with this supervisor.
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    const operation: OwnedProcess = {
      operationId,
      providerId: request.providerId,
      sessionKey: request.sessionKey,
      cwd: request.cwd,
      child,
      state: 'starting',
      startedAt: Date.now(),
      lockKeys: lock ? [lock] : [],
      stdout: '',
      stderr: '',
    };
    this.processes.set(operationId, operation);
    if (lock) this.sessionLocks.add(lock);
    this.capture(child.stdout, operation, 'stdout');
    this.capture(child.stderr, operation, 'stderr');
    child.once('spawn', () => {
      if (operation.state === 'starting') operation.state = 'running';
      this.emit('changed', operation);
    });
    child.once('error', (error) => {
      if (operation.state !== 'cancelled') operation.state = 'failed';
      operation.exitCode = null;
      operation.finishedAt = Date.now();
      this.emit('changed', operation, error);
      this.release(operation);
    });
    child.once('exit', (code) => {
      operation.exitCode = code;
      if (operation.state !== 'cancelled') operation.state = code === 0 ? 'completed' : 'failed';
      operation.finishedAt = Date.now();
      // A finished turn must not leave its helpers behind: sweep whatever the CLI spawned.
      signalTree(child, 'SIGTERM');
      this.emit('changed', operation);
      this.release(operation);
    });
    this.emit('changed', operation);
    return operation;
  }

  /** Resolve only after the OS acknowledges spawn; reject pre-spawn failures. */
  async spawnAcknowledged(request: SpawnRequest): Promise<OwnedProcess> {
    let operation: OwnedProcess | undefined;
    const acknowledged = new Promise<OwnedProcess>((resolve, reject) => {
      const changed = (candidate: OwnedProcess, error?: Error) => {
        if (candidate !== operation) return;
        if (candidate.state === 'running') {
          this.off('changed', changed);
          resolve(candidate);
        } else if (candidate.state === 'failed') {
          this.off('changed', changed);
          reject(error ?? new Error('SPAWN_FAILED'));
        }
      };
      this.on('changed', changed);
      try {
        operation = this.spawn(request);
      } catch (error) {
        this.off('changed', changed);
        reject(error);
      }
    });
    return acknowledged;
  }

  cancel(operationId: string): OwnedProcess | undefined {
    const operation = this.processes.get(operationId);
    if (!operation || operation.state === 'completed' || operation.state === 'failed')
      return operation;
    operation.state = 'cancelled';
    signalTree(operation.child, 'SIGTERM');
    this.emit('changed', operation);
    return operation;
  }
  /**
   * Associates a running operation with the session it turned out to own (correlated from the
   * provider's own SessionStart). The session becomes busy for replies until the operation ends.
   * Returns false, changing nothing, if the operation is over or that session is already locked.
   */
  bindSession(operationId: string, sessionKey: SessionKey): boolean {
    const operation = this.processes.get(operationId);
    if (!operation || operation.sessionKey || this.isTerminal(operation)) return false;
    const lock = `${sessionKey.providerId}:${sessionKey.sessionId}`;
    if (this.sessionLocks.has(lock)) return false;
    operation.sessionKey = sessionKey;
    operation.lockKeys.push(lock);
    this.sessionLocks.add(lock);
    this.emit('changed', operation);
    return true;
  }
  get(operationId: string): OwnedProcess | undefined {
    return this.processes.get(operationId);
  }
  list(): readonly OwnedProcess[] {
    return [...this.processes.values()];
  }
  operationState(operation: OwnedProcess): OperationState {
    return {
      operationId: operation.operationId,
      providerId: operation.providerId,
      sessionKey: operation.sessionKey,
      state: operation.state,
      startedAt: operation.startedAt,
      finishedAt: operation.finishedAt,
    };
  }
  async stop(graceMs = 5_000, forceMs = 2_000): Promise<void> {
    for (const operation of this.processes.values())
      if (operation.state === 'starting' || operation.state === 'running')
        this.cancel(operation.operationId);
    await this.waitForOwnedExit(graceMs);
    for (const operation of this.processes.values())
      if (!this.isTerminal(operation)) signalTree(operation.child, 'SIGKILL');
    await this.waitForOwnedExit(forceMs);
  }
  private capture(
    stream: NodeJS.ReadableStream | null,
    operation: OwnedProcess,
    target: 'stdout' | 'stderr',
  ): void {
    if (!stream) return;
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      const next = operation[target] + chunk;
      operation[target] = next.length > 65_536 ? next.slice(-65_536) : next;
    });
  }
  /** `finishedAt` is set on exit or spawn error, including death by signal (exitCode stays null). */
  private isTerminal(operation: OwnedProcess): boolean {
    return operation.finishedAt !== undefined;
  }
  private async waitForOwnedExit(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while ([...this.processes.values()].some((operation) => !this.isTerminal(operation))) {
      if (Date.now() >= deadline) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }
  private release(operation: OwnedProcess): void {
    for (const lock of operation.lockKeys) this.sessionLocks.delete(lock);
  }
}
