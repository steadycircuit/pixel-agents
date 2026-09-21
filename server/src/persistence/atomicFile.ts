import { randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import * as path from 'node:path';

/** Windows reports transient sharing violations (AV/indexers) as these; POSIX never retries. */
const RETRYABLE_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_ATTEMPTS = 6;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return; // directories cannot be opened for sync there
  const handle = await open(directory, 'r').catch(() => undefined);
  try {
    await handle?.sync();
  } catch {
    /* some filesystems reject directory fsync; the rename itself is still atomic */
  } finally {
    await handle?.close();
  }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (process.platform !== 'win32' || !RETRYABLE_RENAME.has(code) || attempt >= RENAME_ATTEMPTS)
        throw error;
      await sleep(25 * 2 ** attempt);
    }
  }
}

/**
 * Durably replaces `file`: unique same-directory temp name, data flushed to disk, atomic rename,
 * directory flushed. Every failure (ENOSPC, EACCES, rename) propagates after the temp is removed,
 * and the previous contents are left untouched.
 */
export async function writeFileAtomic(
  file: string,
  data: string | Buffer,
  mode = 0o600,
): Promise<void> {
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', mode);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  await syncDirectory(directory);
}

export { renameWithRetry, syncDirectory };
