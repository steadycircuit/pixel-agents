import * as fs from 'node:fs';
import * as path from 'node:path';

import type { PreviousSessionRecord, ProviderId } from '../../core/src/desktop/types.js';
import type { HookProvider } from '../../core/src/provider.js';
import { getAgentDisplayName } from './agentNames.js';

/** Transcripts written to this recently may still have a live writer, so they cannot be resumed. */
export const WRITER_QUIET_MS = 600_000;
/** Smaller transcripts hold no conversation worth resuming (start-up noise only). */
export const MIN_TRANSCRIPT_BYTES = 3_072;
export const MAX_DISCOVERED_SESSIONS = 100;
const MAX_DEPTH = 6;
const MAX_FILES = 5_000;

export interface DiscoveryOptions {
  /** Overrides the provider's own roots (tests, and user-approved extra locations). */
  roots?: string[];
  now?: number;
  /** Session ids that are already live agents and so are not "previous". */
  exclude?: ReadonlySet<string>;
}

function listTranscripts(roots: readonly string[]): string[] {
  const files: string[] = [];
  const visit = (directory: string, depth: number): void => {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      // Symlinks are not followed: a transcript root must not be a route out of itself.
      if (entry.isDirectory()) visit(entryPath, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(entryPath);
    }
  };
  for (const root of roots) visit(root, 0);
  return files;
}

/**
 * Generic header read for providers without `getSessionInfo`: the first records of a Claude-style
 * transcript carry `cwd` and `sessionId`. Never trusts the project-directory name, which is a lossy
 * encoding of the path and cannot be resumed from.
 */
function readHeaderInfo(file: string): { sessionId?: string; cwd?: string } {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(64 * 1024);
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
      const info: { sessionId?: string; cwd?: string } = {};
      for (const line of buffer.subarray(0, bytes).toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        let record: Record<string, unknown>;
        try {
          record = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue; // a partial trailing line, or noise
        }
        if (typeof record['sessionId'] === 'string') info.sessionId ??= record['sessionId'];
        if (typeof record['cwd'] === 'string') info.cwd ??= record['cwd'];
        if (info.sessionId && info.cwd) break;
      }
      return info;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return {};
  }
}

/** Scans one provider's transcript roots. Reads only file metadata and the provider's own header parse. */
export function discoverSessions(
  provider: HookProvider,
  providerId: ProviderId,
  options: DiscoveryOptions = {},
): PreviousSessionRecord[] {
  const roots = options.roots ?? provider.getAllSessionRoots?.() ?? [];
  const now = options.now ?? Date.now();
  const records: PreviousSessionRecord[] = [];
  for (const file of listTranscripts(roots)) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (stat.size < MIN_TRANSCRIPT_BYTES) continue;
    const info = provider.getSessionInfo?.(file) ?? readHeaderInfo(file);
    const sessionId = info.sessionId ?? path.basename(file, '.jsonl');
    if (!sessionId || options.exclude?.has(sessionId)) continue;
    const cwd = info.cwd ? path.resolve(info.cwd) : '';
    const folderName = (cwd && path.basename(cwd)) || path.basename(path.dirname(file));
    const recentlyWritten = now - stat.mtimeMs <= WRITER_QUIET_MS;
    const liveWriter = recentlyWritten || provider.isSessionActive?.(sessionId) === true;
    const reason = liveWriter
      ? 'Another process may still be writing this session; wait for it to finish.'
      : cwd
        ? undefined
        : 'The session does not record its working directory, so it cannot be resumed.';
    records.push({
      sessionKey: { providerId, sessionId },
      displayName: getAgentDisplayName(sessionId, folderName),
      folderName,
      cwd,
      lastActivityAt: Math.round(stat.mtimeMs),
      eligible: reason === undefined,
      ...(reason ? { reason } : {}),
    });
  }
  return records
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    .slice(0, MAX_DISCOVERED_SESSIONS);
}
