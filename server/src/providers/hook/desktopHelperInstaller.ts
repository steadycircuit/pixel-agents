import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, copyFile, mkdir, readFile, rename, unlink } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { installHooks as installClaudeHooks } from './claude/claudeHookInstaller.js';
import {
  installHooks as installCodexHooks,
  refreshHookScript as refreshCodexScript,
} from './codex/codexHookInstaller.js';

export type DesktopHookProvider = 'claude' | 'codex';
export interface DesktopHelperInstallOptions {
  providerId: DesktopHookProvider;
  source: string;
  helperVersion: string;
  dataRoot?: string;
  platform?: NodeJS.Platform;
  architecture?: string;
  /** Test seam; production uses the provider's guarded settings installer. */
  installProviderHooks?: (command: string) => Promise<void>;
}

export function desktopHelperPath(
  options: Omit<DesktopHelperInstallOptions, 'providerId' | 'source'>,
): string {
  const dataRoot = options.dataRoot ?? path.join(os.homedir(), '.pixel-agents');
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  return path.join(
    dataRoot,
    'hooks',
    'desktop',
    options.helperVersion,
    `${platform}-${architecture}`,
    `pixel-agents-hook${platform === 'win32' ? '.exe' : ''}`,
  );
}

/** Copy an immutable helper version before mutating a provider settings file. */
export async function installDesktopHelper(
  options: DesktopHelperInstallOptions,
): Promise<{ helperPath: string; command: string }> {
  const helperPath = desktopHelperPath(options);
  await access(options.source, constants.R_OK);
  await mkdir(path.dirname(helperPath), { recursive: true, mode: 0o700 });
  const sourceHash = hash(await readFile(options.source));
  const existingHash = await readFile(helperPath)
    .then(hash)
    .catch(() => undefined);
  if (existingHash !== sourceHash) {
    const temporary = `${helperPath}.${process.pid}.tmp`;
    await copyFile(options.source, temporary);
    if ((options.platform ?? process.platform) !== 'win32') await chmod(temporary, 0o700);
    if (hash(await readFile(temporary)) !== sourceHash) {
      await unlink(temporary).catch(() => undefined);
      throw new Error('Standalone hook helper checksum verification failed');
    }
    await rename(temporary, helperPath);
  }
  const command = `"${helperPath}" --provider ${options.providerId}`;
  if (options.installProviderHooks) await options.installProviderHooks(command);
  else if (options.providerId === 'claude') await installClaudeHooks(command);
  else await installCodexHooks(command);
  return { helperPath, command };
}

function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Codex hooks for the desktop app. Codex refuses to run a hook it has not reviewed and tracks
 * approval by the hook's exact definition, so unlike Claude this does NOT use the versioned helper
 * path (which would change on every release and re-trigger review). It installs the node-script
 * form — the definition users already approved, at a path that never changes — and refreshes the
 * script file behind it so it forwards to the desktop app. Approval survives app updates.
 */
export async function installCodexScriptHooks(scriptSource: string): Promise<void> {
  if (!refreshCodexScript(scriptSource))
    throw new Error('Could not install the Codex hook script (source missing or unwritable)');
  await installCodexHooks(); // default command: node "<~/.pixel-agents/hooks/codex-hook.js>"
}
