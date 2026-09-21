import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export const LOG_MAX_BYTES = 5 * 1024 * 1024;
export const LOG_MAX_FILES = 5;

export type LogLevel = 'info' | 'warn' | 'error';
export interface LogContext {
  appVersion?: string;
  runtime?: string;
  platform?: string;
  instanceId?: string;
}
export interface LoggerOptions {
  dir: string;
  context?: LogContext;
  maxBytes?: number;
  maxFiles?: number;
  home?: string;
  now?: () => Date;
}
export interface Logger {
  log(level: LogLevel, message: string, fields?: Record<string, unknown>): void;
  /** Resolves once everything queued so far is on disk. */
  flush(): Promise<void>;
  readonly file: string;
}

/** Field names whose values are never logged: prompts, transcripts and credentials. */
const REDACTED_KEYS =
  /^(prompt|initialprompt|text|content|transcript|message_?content|authorization|token|password|secret|api_?key|cookie)$/i;
const REDACTED = '[redacted]';

/** Redacts credentials and personal paths from free text. Applied to every message and field. */
export function redactText(text: string, home = os.homedir()): string {
  let result = text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`)
    .replace(
      /\b((?:api[_-]?key|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s"',;&]{6,}/gi,
      `$1${REDACTED}`,
    )
    .replace(/\b(sk|pk|ghp|gho|ghs|xox[abp])[-_][A-Za-z0-9_-]{16,}/g, REDACTED);
  if (home && home.length > 1) result = result.split(home).join('~');
  return result;
}

export function redactValue(value: unknown, home: string, depth = 0): unknown {
  if (typeof value === 'string') return redactText(value, home);
  if (value instanceof Error) return redactText(value.stack ?? value.message, home);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 4) return '[truncated]';
  if (Array.isArray(value))
    return value.slice(0, 50).map((item) => redactValue(item, home, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 50)
      .map(([key, item]) => [
        key,
        REDACTED_KEYS.test(key) ? REDACTED : redactValue(item, home, depth + 1),
      ]),
  );
}

export function createLogger(options: LoggerOptions): Logger {
  const maxBytes = options.maxBytes ?? LOG_MAX_BYTES;
  const maxFiles = options.maxFiles ?? LOG_MAX_FILES;
  const home = options.home ?? os.homedir();
  const file = path.join(options.dir, 'pixel-agents.log');
  let queue = Promise.resolve();

  const rotate = async () => {
    const size = (await stat(file).catch(() => undefined))?.size ?? 0;
    if (size < maxBytes) return;
    await rm(`${file}.${maxFiles - 1}`, { force: true });
    for (let index = maxFiles - 2; index >= 1; index--)
      await rename(`${file}.${index}`, `${file}.${index + 1}`).catch(() => undefined);
    await rename(file, `${file}.1`).catch(() => undefined);
  };

  return {
    file,
    log(level, message, fields) {
      const line = `${JSON.stringify({
        time: (options.now?.() ?? new Date()).toISOString(),
        level,
        ...options.context,
        message: redactText(message, home),
        ...(fields ? { fields: redactValue(fields, home) } : {}),
      })}\n`;
      queue = queue
        .then(async () => {
          await mkdir(options.dir, { recursive: true, mode: 0o700 });
          await rotate();
          await appendFile(file, line, { mode: 0o600 });
        })
        // Logging must never take the app down or wedge later writes.
        .catch(() => undefined);
    },
    flush: () => queue,
  };
}

/** Mirrors console output into the logger so existing `console.*` diagnostics are captured. */
export function captureConsole(logger: Logger): void {
  const levels = { log: 'info', info: 'info', warn: 'warn', error: 'error' } as const;
  for (const [method, level] of Object.entries(levels) as Array<[keyof typeof levels, LogLevel]>) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      original(...args);
      logger.log(
        level,
        args.map((arg) => (typeof arg === 'string' ? arg : redactText(String(arg)))).join(' '),
      );
    };
  }
}
