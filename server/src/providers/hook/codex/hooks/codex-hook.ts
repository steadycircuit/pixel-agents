import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import { HOOK_API_PREFIX, SERVER_JSON_DIR, SERVER_JSON_NAME } from '../../../../constants.js';
import type { ServerTarget } from '../../../../serverConfig.js';
import { isServerTarget } from '../../../../serverConfig.js';
import { readDesktopTarget } from '../../desktopTargets.js';

const root = path.join(os.homedir(), SERVER_JSON_DIR);
const registry = path.join(root, 'servers');

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function servers(): ServerTarget[] {
  const result: ServerTarget[] = [];
  try {
    for (const file of fs.readdirSync(registry).filter((name) => name.endsWith('.json'))) {
      try {
        const value = JSON.parse(fs.readFileSync(path.join(registry, file), 'utf8')) as unknown;
        if (isServerTarget(value) && alive(value.pid)) result.push(value);
      } catch {
        /* Ignore a concurrent or malformed registry entry. */
      }
    }
  } catch {
    /* Fall back to the legacy single-server pointer below. */
  }
  const desktop = readDesktopTarget();
  if (
    desktop &&
    !result.some((server) => server.pid === desktop.pid && server.port === desktop.port)
  )
    result.push(desktop);
  if (result.length > 0) return result;
  try {
    const value = JSON.parse(fs.readFileSync(path.join(root, SERVER_JSON_NAME), 'utf8')) as unknown;
    return isServerTarget(value) ? [value] : [];
  } catch {
    return [];
  }
}

function post(server: ServerTarget, body: string): Promise<void> {
  return new Promise((resolve) => {
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port: server.port,
        path: `${HOOK_API_PREFIX}/codex`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${server.token}`,
        },
        timeout: 2_000,
      },
      (response) => {
        response.resume();
        resolve();
      },
    );
    request.on('error', () => resolve());
    request.on('timeout', () => {
      request.destroy();
      resolve();
    });
    request.end(body);
  });
}

async function main(): Promise<void> {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  try {
    const event = JSON.parse(input) as Record<string, unknown>;
    const body = JSON.stringify(event);
    await Promise.all(servers().map((server) => post(server, body)));
  } catch {
    /* Hooks must never block or fail the Codex operation. */
  }
}

void main().finally(() => process.exit(0));
