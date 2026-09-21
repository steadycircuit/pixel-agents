import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const suffix = process.platform === 'win32' ? '.exe' : '';
const helper = path.resolve('dist', 'desktop-hooks', `pixel-agents-hook${suffix}`);
const root = await mkdtemp(path.join(os.tmpdir(), 'pixel-hook-helper-'));
let server;
try {
  let receive;
  const received = new Promise((resolve) => {
    receive = resolve;
  });
  server = await new Promise((resolve, reject) => {
    const listener = http.createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        response.writeHead(202);
        response.end();
        receive({ path: request.url, authorization: request.headers.authorization, body });
      });
    });
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const port = server.address().port;
  const desktop = path.join(root, '.pixel-agents', 'desktop');
  await mkdir(desktop, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(desktop, 'instance.json'),
    JSON.stringify({
      pid: process.pid,
      instanceId: 'smoke',
      startedAt: Date.now(),
      port,
      token: 'smoke-token',
    }),
    { mode: 0o600 },
  );
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(helper, ['--provider', 'codex'], {
      env: { ...process.env, HOME: root, USERPROFILE: root },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.once('error', reject);
    child.once('exit', resolve);
    child.stdin.end(JSON.stringify({ session_id: 'helper-session', event: 'Stop' }));
  });
  if (exitCode !== 0) throw new Error(`Hook helper exited with ${exitCode}`);
  const delivery = await Promise.race([
    received,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Hook helper timed out')), 3_000)),
  ]);
  if (
    delivery.path !== '/api/hooks/codex' ||
    delivery.authorization !== 'Bearer smoke-token' ||
    !delivery.body.includes('helper-session')
  )
    throw new Error('Hook helper delivered an unexpected request');
  console.log('Standalone hook helper smoke test passed');
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
