import * as http from 'node:http';

import { readDesktopTarget } from './desktopTargets.js';

const MAX_INPUT_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 2_000;

function providerFromArgs(args: string[]): 'claude' | 'codex' | undefined {
  const index = args.indexOf('--provider');
  const provider = index === -1 ? undefined : args[index + 1];
  return provider === 'claude' || provider === 'codex' ? provider : undefined;
}

function readInput(): Promise<string | undefined> {
  return new Promise((resolve) => {
    let size = 0;
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      size += Buffer.byteLength(chunk);
      if (size <= MAX_INPUT_BYTES) input += chunk;
    });
    process.stdin.on('end', () => resolve(size <= MAX_INPUT_BYTES ? input : undefined));
    process.stdin.on('error', () => resolve(undefined));
  });
}

function post(providerId: 'claude' | 'codex', body: string): Promise<void> {
  const target = readDesktopTarget();
  if (!target) return Promise.resolve();
  return new Promise((resolve) => {
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port: target.port,
        path: `/api/hooks/${providerId}`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${target.token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: REQUEST_TIMEOUT_MS,
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
  const providerId = providerFromArgs(process.argv.slice(2));
  if (!providerId) return;
  const input = await readInput();
  if (!input) return;
  try {
    JSON.parse(input);
  } catch {
    return;
  }
  await post(providerId, input);
}

void main().finally(() => process.exit(0));
