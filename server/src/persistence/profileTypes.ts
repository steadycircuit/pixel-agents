import type {
  DesktopAgent,
  DesktopSeat,
  DesktopSettings,
  ProviderId,
  SessionKeyString,
} from '../../../core/src/desktop/types.js';

export const DESKTOP_SCHEMA_VERSION = 1;

export interface DesktopConfig {
  schemaVersion: 1;
  settings: DesktopSettings;
  /** Per-provider consent to edit that provider's hook settings. Absent = never asked. */
  hooksConsent?: Partial<Record<ProviderId, 'granted' | 'declined'>>;
  /** User-approved directories of additional furniture/character/pet assets. */
  externalAssetDirectories?: string[];
}
export interface DesktopState {
  schemaVersion: 1;
  agents: DesktopAgent[];
  seats: Record<SessionKeyString, DesktopSeat>;
  seatsRevision: number;
  /** Provider-qualified dismissed sessions. */
  dismissed: string[];
  /**
   * Dismissals imported from an unqualified legacy list that could not be tied to a provider.
   * Checked against every provider's session ids until the session is explicitly re-employed.
   */
  legacyDismissed?: string[];
}
export interface DesktopLayout {
  schemaVersion: 1;
  layoutRevision: number;
  layout: unknown;
}
export interface DesktopProfile {
  root: string;
  config: DesktopConfig;
  state: DesktopState;
  layout: DesktopLayout;
}

export const DEFAULT_SETTINGS: DesktopSettings = {
  soundEnabled: true,
  alwaysShowLabels: false,
  ghostHeadlessAgents: false,
  watchAllSessions: false,
  showAreas: false,
  hooksInfoShown: false,
  workspaces: [],
  providerExecutables: {},
  hooksEnabled: { claude: false, codex: false },
};

export type MigrationErrorCode =
  'SOURCE_CORRUPT' | 'UNSUPPORTED_SCHEMA' | 'BACKUP_FAILED' | 'RECOVERY_FAILED';

/** A migration/recovery failure the user must resolve; nothing has been overwritten when thrown. */
export class MigrationError extends Error {
  constructor(
    readonly code: MigrationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MigrationError';
  }
}
