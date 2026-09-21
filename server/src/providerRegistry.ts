import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import * as path from 'node:path';

import type {
  DesktopSettings,
  ProviderCapabilities,
  ProviderId,
} from '../../core/src/desktop/types.js';
import type { HookProvider } from '../../core/src/provider.js';

export interface ExecutableProbeResult {
  executable: string;
  version: string;
}
export type ExecutableProbe = (
  providerId: ProviderId,
  configuredPath?: string,
) => Promise<ExecutableProbeResult>;
export interface DesktopProviderRegistry {
  refresh(settings: DesktopSettings): Promise<ProviderCapabilities[]>;
  provider(providerId: ProviderId): HookProvider | undefined;
  capabilities(providerId: ProviderId): ProviderCapabilities | undefined;
}

const providerIds = new Set<ProviderId>(['claude', 'codex']);

/** Concurrent provider catalog and executable availability probe. */
export function createProviderRegistry(
  providers: readonly HookProvider[],
  probe: ExecutableProbe = probeProviderExecutable,
): DesktopProviderRegistry {
  const byId = new Map<ProviderId, HookProvider>();
  const current = new Map<ProviderId, ProviderCapabilities>();
  for (const provider of providers) {
    if (providerIds.has(provider.id as ProviderId)) byId.set(provider.id as ProviderId, provider);
  }

  return {
    async refresh(settings) {
      const capabilities = await Promise.all(
        (['claude', 'codex'] as const).map(async (providerId): Promise<ProviderCapabilities> => {
          const provider = byId.get(providerId);
          if (!provider) return unavailable(providerId, 'Provider is not bundled');
          try {
            const result = await probe(providerId, settings.providerExecutables[providerId]);
            return {
              providerId,
              available: true,
              canLaunch: typeof provider.buildLaunchCommand === 'function',
              canReply: typeof provider.buildPromptCommand === 'function',
              supportsTeams: provider.team !== undefined,
              executable: result.executable,
              version: result.version,
            };
          } catch (error) {
            return unavailable(
              providerId,
              error instanceof Error ? error.message : 'Executable probe failed',
              provider.team !== undefined,
            );
          }
        }),
      );
      current.clear();
      for (const entry of capabilities) current.set(entry.providerId, entry);
      return capabilities;
    },
    provider: (providerId) => byId.get(providerId),
    capabilities: (providerId) => current.get(providerId),
  };
}

function unavailable(
  providerId: ProviderId,
  error: string,
  supportsTeams = providerId === 'claude',
): ProviderCapabilities {
  return {
    providerId,
    available: false,
    canLaunch: false,
    canReply: false,
    supportsTeams,
    error,
  };
}

export async function probeProviderExecutable(
  providerId: ProviderId,
  configuredPath?: string,
): Promise<ExecutableProbeResult> {
  const executable = configuredPath
    ? await validateConfiguredExecutable(configuredPath)
    : await findOnPath(providerId);
  const version = await readVersion(executable);
  return { executable, version };
}

async function validateConfiguredExecutable(configuredPath: string): Promise<string> {
  if (!path.isAbsolute(configuredPath))
    throw new Error('Configured executable path must be absolute');
  await access(
    configuredPath,
    process.platform === 'win32' ? constants.F_OK : constants.X_OK,
  ).catch(() => {
    throw new Error('Configured executable is missing or not executable');
  });
  return configuredPath;
}

async function findOnPath(command: ProviderId): Promise<string> {
  const pathEntries = (process.env['PATH'] ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .slice(0, 64);
  const extensions =
    process.platform === 'win32'
      ? (process.env['PATHEXT'] ?? '.EXE;.COM').split(';').filter(Boolean)
      : [''];
  for (const directory of pathEntries) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension.toLowerCase()}`);
      try {
        await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch {
        /* continue bounded search */
      }
    }
  }
  throw new Error(`${command} CLI was not found; configure its absolute path`);
}

function readVersion(executable: string, timeoutMs = 3_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--version'], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    const append = (chunk: Buffer | string) => {
      if (output.length < 4_096) output += chunk.toString().slice(0, 4_096 - output.length);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Executable version probe timed out'));
    }, timeoutMs);
    child.once('error', () => {
      clearTimeout(timeout);
      reject(new Error('Executable could not be started'));
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`Executable version probe exited with code ${code ?? 'unknown'}`));
        return;
      }
      const version = output.trim().split(/\r?\n/, 1)[0];
      if (!version) {
        reject(new Error('Executable returned no version'));
        return;
      }
      resolve(version);
    });
  });
}
