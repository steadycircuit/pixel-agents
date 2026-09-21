import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import type {
  DesktopAgent,
  DesktopSeat,
  ProviderId,
  SessionKeyString,
} from '../../../core/src/desktop/types.js';
import {
  DEFAULT_SETTINGS,
  type DesktopConfig,
  type DesktopLayout,
  type DesktopState,
  MigrationError,
} from './profileTypes.js';

export interface LegacySource {
  path: string;
  exists: boolean;
  hash: string | null;
  value?: unknown;
  parseError?: string;
}
export interface LegacyInventory {
  config: LegacySource;
  standaloneState: LegacySource;
  vscodeState: LegacySource;
  layout: LegacySource;
}
export interface ImportDiagnostics {
  stateSource: 'standalone' | 'vscode' | 'none';
  /** Agent records whose provider could not be established; excluded from live restoration. */
  ambiguousAgents: unknown[];
  /** Seat records that matched no imported agent. */
  unmatchedSeats: string[];
  /** Agents left unseated because an earlier agent already claimed their seat. */
  displacedSeats: string[];
  /** Dismissed ids that could not be tied to a provider (kept as tombstones). */
  legacyDismissed: string[];
}
export interface DesktopGeneration {
  config: DesktopConfig;
  state: DesktopState;
  layout: DesktopLayout;
  diagnostics: ImportDiagnostics;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isBoolean = (value: unknown, fallback: boolean) =>
  typeof value === 'boolean' ? value : fallback;
const isNumber = (value: unknown) => (typeof value === 'number' ? value : undefined);

async function readSource(file: string): Promise<LegacySource> {
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { path: file, exists: false, hash: null };
    throw new MigrationError('SOURCE_CORRUPT', `${path.basename(file)} is unreadable: ${error}`);
  }
  const hash = createHash('sha256').update(bytes).digest('hex');
  try {
    return { path: file, exists: true, hash, value: JSON.parse(bytes.toString('utf8')) };
  } catch (error) {
    return { path: file, exists: true, hash, parseError: (error as Error).message };
  }
}

/** Reads the raw legacy files (not `readConfig()`, which would hide what was actually present). */
export async function inspectLegacySources(legacyRoot: string): Promise<LegacyInventory> {
  const [config, standaloneState, vscodeState, layout] = await Promise.all(
    ['config.json', 'standalone-state.json', 'vscode-state.json', 'layout.json'].map((name) =>
      readSource(path.join(legacyRoot, name)),
    ),
  );
  return { config, standaloneState, vscodeState, layout };
}

function requireValid(source: LegacySource, valid: (value: unknown) => boolean): unknown {
  if (source.parseError !== undefined || (source.exists && !valid(source.value)))
    throw new MigrationError(
      'SOURCE_CORRUPT',
      `${path.basename(source.path)} is present but not valid (${source.parseError ?? 'unexpected structure'}); ` +
        'repair or move it aside, then reopen Pixel Agents. No data was changed.',
    );
  return source.value;
}

const validState = (value: unknown) =>
  isObject(value) &&
  (value['agents'] === undefined || Array.isArray(value['agents'])) &&
  (value['seats'] === undefined || isObject(value['seats']));
const validLayout = (value: unknown) =>
  isObject(value) && (value['tiles'] === undefined || Array.isArray(value['tiles']));

function providerOf(item: Record<string, unknown>): ProviderId | undefined {
  if (item['providerId'] === 'claude' || item['providerId'] === 'codex') return item['providerId'];
  // Unlabelled records are attributed only on evidence: the transcript root they were read from.
  const transcript = typeof item['jsonlFile'] === 'string' ? item['jsonlFile'] : '';
  if (/[\\/]\.claude[\\/]/.test(transcript)) return 'claude';
  if (/[\\/]\.codex[\\/]/.test(transcript)) return 'codex';
  return undefined;
}

export function buildDesktopGeneration(inventory: LegacyInventory): DesktopGeneration {
  const legacyConfig = requireValid(inventory.config, isObject);
  const standalone = inventory.standaloneState;
  // A corrupt preferred file must not silently fall back to the other surface's state.
  const [stateSource, legacyState] = standalone.exists
    ? (['standalone', requireValid(standalone, validState)] as const)
    : inventory.vscodeState.exists
      ? (['vscode', requireValid(inventory.vscodeState, validState)] as const)
      : (['none', undefined] as const);
  const legacyLayout = requireValid(inventory.layout, validLayout);

  const config = configFromLegacy(legacyConfig);
  const { state, diagnostics } = stateFromLegacy(legacyState, legacyConfig, stateSource);
  const layout: DesktopLayout = {
    schemaVersion: 1,
    layoutRevision: 0,
    layout: isObject(legacyLayout) ? legacyLayout : null,
  };
  return { config, state, layout, diagnostics };
}

function configFromLegacy(value: unknown): DesktopConfig {
  const config = isObject(value) ? value : {};
  const standalone = isObject(config['standalone']) ? config['standalone'] : {};
  const hooksEnabled = isObject(config['hooksEnabled']) ? config['hooksEnabled'] : {};
  const consent = isObject(config['hooksConsent']) ? config['hooksConsent'] : {};
  const directories = Array.isArray(config['externalAssetDirectories'])
    ? config['externalAssetDirectories'].filter(
        (entry): entry is string => typeof entry === 'string' && entry.length > 0,
      )
    : [];
  const result: DesktopConfig = {
    schemaVersion: 1,
    settings: {
      ...DEFAULT_SETTINGS,
      soundEnabled: isBoolean(standalone['soundEnabled'], DEFAULT_SETTINGS.soundEnabled),
      alwaysShowLabels: isBoolean(
        standalone['alwaysShowLabels'],
        DEFAULT_SETTINGS.alwaysShowLabels,
      ),
      ghostHeadlessAgents: isBoolean(
        standalone['ghostHeadlessAgents'],
        DEFAULT_SETTINGS.ghostHeadlessAgents,
      ),
      watchAllSessions: isBoolean(
        standalone['watchAllSessions'],
        DEFAULT_SETTINGS.watchAllSessions,
      ),
      showAreas: isBoolean(standalone['showAreas'], DEFAULT_SETTINGS.showAreas),
      hooksInfoShown: isBoolean(standalone['hooksInfoShown'], DEFAULT_SETTINGS.hooksInfoShown),
      hooksEnabled: {
        claude: isBoolean(hooksEnabled['claude'], DEFAULT_SETTINGS.hooksEnabled.claude),
        codex: isBoolean(hooksEnabled['codex'], DEFAULT_SETTINGS.hooksEnabled.codex),
      },
    },
    externalAssetDirectories: directories,
  };
  // Unanswered stays unanswered: only an explicit granted/declined is carried over.
  const hooksConsent: NonNullable<DesktopConfig['hooksConsent']> = {};
  for (const providerId of ['claude', 'codex'] as const) {
    const answer = consent[providerId];
    if (answer === 'granted' || answer === 'declined') hooksConsent[providerId] = answer;
  }
  if (Object.keys(hooksConsent).length > 0) result.hooksConsent = hooksConsent;
  return result;
}

function stateFromLegacy(
  legacyState: unknown,
  legacyConfig: unknown,
  stateSource: ImportDiagnostics['stateSource'],
): { state: DesktopState; diagnostics: ImportDiagnostics } {
  const legacy = isObject(legacyState) ? legacyState : {};
  const diagnostics: ImportDiagnostics = {
    stateSource,
    ambiguousAgents: [],
    unmatchedSeats: [],
    displacedSeats: [],
    legacyDismissed: [],
  };
  const seen = new Set<string>();
  const keyByNumericId = new Map<number, SessionKeyString>();
  const agents: DesktopAgent[] = [];
  for (const item of Array.isArray(legacy['agents']) ? legacy['agents'] : []) {
    if (!isObject(item) || typeof item['sessionId'] !== 'string' || !item['sessionId']) continue;
    const providerId = providerOf(item);
    if (!providerId) {
      diagnostics.ambiguousAgents.push(item);
      continue;
    }
    const key = `${providerId}:${item['sessionId']}` as SessionKeyString;
    if (seen.has(key)) continue;
    seen.add(key);
    const numericId =
      typeof item['id'] === 'number' && Number.isSafeInteger(item['id']) ? item['id'] : undefined;
    if (numericId !== undefined) keyByNumericId.set(numericId, key);
    agents.push({
      agentId: numericId ?? agents.length + 1,
      sessionKey: { providerId, sessionId: item['sessionId'] },
      cwd: typeof item['projectDir'] === 'string' ? item['projectDir'] : '',
      displayName:
        typeof item['agentName'] === 'string' && item['agentName']
          ? item['agentName']
          : typeof item['folderName'] === 'string' && item['folderName']
            ? item['folderName']
            : item['sessionId'].slice(0, 8),
      palette: isNumber(item['palette']),
      hueShift: isNumber(item['hueShift']),
      isExternal: item['isExternal'] === true,
      retained: true,
      dismissed: false,
      writerActive: false,
      status: 'ended',
      lastActivityAt: 0,
    });
  }

  // Seats: remap numeric keys through the agent record; earlier source order wins a contested seat.
  const seats: Record<SessionKeyString, DesktopSeat> = {};
  const claimed = new Set<string>();
  if (isObject(legacy['seats'])) {
    for (const [legacyId, rawSeat] of Object.entries(legacy['seats'])) {
      const sessionKey = keyByNumericId.get(Number(legacyId));
      if (!sessionKey || !isObject(rawSeat)) {
        diagnostics.unmatchedSeats.push(legacyId);
        continue;
      }
      let seatId = typeof rawSeat['seatId'] === 'string' ? rawSeat['seatId'] : undefined;
      if (seatId !== undefined && claimed.has(seatId)) {
        diagnostics.displacedSeats.push(sessionKey);
        seatId = undefined;
      }
      if (seatId !== undefined) claimed.add(seatId);
      seats[sessionKey] = {
        palette: isNumber(rawSeat['palette']),
        hueShift: isNumber(rawSeat['hueShift']),
        seatId,
      };
    }
  }

  // Dismissals: qualify when the session is known; otherwise keep a tombstone. Never drop one.
  const config = isObject(legacyConfig) ? legacyConfig : {};
  const dismissed = new Set<string>();
  const knownBySessionId = new Map<string, ProviderId[]>();
  for (const agent of agents) {
    const list = knownBySessionId.get(agent.sessionKey.sessionId) ?? [];
    list.push(agent.sessionKey.providerId);
    knownBySessionId.set(agent.sessionKey.sessionId, list);
  }
  for (const id of Array.isArray(config['dismissedSessionIds'])
    ? config['dismissedSessionIds']
    : []) {
    if (typeof id !== 'string' || !id) continue;
    const providers = knownBySessionId.get(id);
    if (providers?.length === 1) dismissed.add(`${providers[0]}:${id}`);
    else diagnostics.legacyDismissed.push(id);
  }
  return {
    state: {
      schemaVersion: 1,
      agents,
      seats,
      seatsRevision: 0,
      dismissed: [...dismissed],
      legacyDismissed: [...new Set(diagnostics.legacyDismissed)],
    },
    diagnostics,
  };
}
