import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

export interface InstanceRecord {
  pid: number;
  instanceId: string;
  startedAt: number;
  port: number;
  token: string;
}
export interface SingleInstanceLock {
  acquire(): Promise<{ primary: boolean; focusedExisting: boolean }>;
  publish(port: number): Promise<void>;
  release(): Promise<void>;
}
export interface SingleInstanceOptions {
  profileRoot: string;
  instanceId: string;
  token: string;
  pid?: number;
  startupRetries?: number;
  retryDelayMs?: number;
  focusOwner?: (record: InstanceRecord) => Promise<boolean>;
}

/** Atomic profile ownership with authenticated owner verification. */
export function createSingleInstanceLock(options: SingleInstanceOptions): SingleInstanceLock {
  const lockPath = path.join(options.profileRoot, 'instance.json');
  const own: InstanceRecord = {
    pid: options.pid ?? process.pid,
    instanceId: options.instanceId,
    startedAt: Date.now(),
    port: 0,
    token: options.token,
  };
  const focusOwner = options.focusOwner ?? verifyAndFocusOwner;
  let owned = false;

  return {
    async acquire() {
      await mkdir(options.profileRoot, { recursive: true, mode: 0o700 });
      const startupRetries = options.startupRetries ?? 20;
      for (let attempt = 0; attempt <= startupRetries + 1; attempt += 1) {
        try {
          const handle = await open(lockPath, 'wx', 0o600);
          try {
            await handle.writeFile(`${JSON.stringify(own, null, 2)}\n`);
          } finally {
            await handle.close();
          }
          owned = true;
          return { primary: true, focusedExisting: false };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }

        const existing = await readRecord(lockPath);
        if (existing?.port && (await focusOwner(existing))) {
          return { primary: false, focusedExisting: true };
        }
        if (existing?.port === 0 && attempt < startupRetries) {
          await delay(options.retryDelayMs ?? 100);
          continue;
        }
        await removeIfSameOwner(lockPath, existing?.instanceId);
      }
      throw new Error('Unable to acquire desktop profile lock');
    },
    async publish(port) {
      if (!owned || !Number.isInteger(port) || port < 1 || port > 65_535)
        throw new Error('Cannot publish invalid instance registration');
      own.port = port;
      const temporary = `${lockPath}.${own.instanceId}.tmp`;
      await writeFile(temporary, `${JSON.stringify(own, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, lockPath);
    },
    async release() {
      if (!owned) return;
      await removeIfSameOwner(lockPath, own.instanceId);
      owned = false;
    },
  };
}

async function verifyAndFocusOwner(record: InstanceRecord): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_000);
  try {
    const headers = { Authorization: `Bearer ${record.token}` };
    const health = await fetch(`http://127.0.0.1:${record.port}/api/health`, {
      headers,
      signal: controller.signal,
    });
    if (!health.ok) return false;
    const body = (await health.json()) as { instanceId?: unknown };
    if (body.instanceId !== record.instanceId) return false;
    const focus = await fetch(`http://127.0.0.1:${record.port}/api/desktop/focus`, {
      method: 'POST',
      headers,
      signal: controller.signal,
    });
    return focus.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function readRecord(file: string): Promise<InstanceRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(file, 'utf8')) as Partial<InstanceRecord>;
    if (
      typeof value.pid !== 'number' ||
      typeof value.instanceId !== 'string' ||
      typeof value.startedAt !== 'number' ||
      typeof value.port !== 'number' ||
      typeof value.token !== 'string'
    )
      return undefined;
    return value as InstanceRecord;
  } catch {
    return undefined;
  }
}

async function removeIfSameOwner(file: string, instanceId: string | undefined): Promise<void> {
  const current = await readRecord(file);
  if (current?.instanceId !== instanceId) return;
  try {
    await unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
