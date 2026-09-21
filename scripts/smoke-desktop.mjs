#!/usr/bin/env node
/**
 * Packaged-app smoke test: launches the REAL built desktop executable (CEF + views://) from outside
 * the repository with an isolated profile, a minimal PATH and fixture provider CLIs, then drives it
 * through the real hook helper and the real renderer.
 *
 *   node scripts/smoke-desktop.mjs [--artifact build/dev-linux-x64] [--keep]
 *
 * The renderer is observed over the loopback CDP port that Electrobun's DEVELOPMENT builds expose
 * (127.0.0.1:9222). Production artifacts do not open it, so this harness needs a dev/test build.
 * Exits non-zero on the first failed check, leaving logs, result JSON and a screenshot in the run
 * directory.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const CDP_PORT = 9222;
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
};

const results = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(description, probe, { timeout = 30_000, interval = 250 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${description}${last ? `: ${last.message}` : ''}`);
}

function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!condition) throw new Error(`Check failed: ${name}${detail ? ` — ${detail}` : ''}`);
}

const portOpen = (port) =>
  new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('error', () => resolve(false));
  });

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function findBundle(artifact) {
  const direct = path.join(artifact, 'bin', 'launcher');
  if (existsSync(direct)) return artifact;
  for (const entry of await readdir(artifact, { withFileTypes: true }).catch(() => [])) {
    const candidate = path.join(artifact, entry.name);
    if (entry.isDirectory() && existsSync(path.join(candidate, 'bin', 'launcher')))
      return candidate;
  }
  throw new Error(`No launchable bundle found under ${artifact}`);
}

const FIXTURE_SLEEP = '^sleep 3117$'; // anchored: must never match a shell that merely mentions it
async function writeFixtures(binDir, logFile) {
  await mkdir(binDir, { recursive: true });
  // A provider CLI stand-in: answers the version probe, records real invocations, and leaves a
  // long-lived descendant so shutdown has to clean up a process tree, not just a direct child.
  const script = (name) => `#!/bin/bash
if [ "$1" = "--version" ]; then echo "${name} 9.9.9 (smoke fixture)"; exit 0; fi
echo "${name} $*" >> "${logFile}"
sleep 3117 &
wait
`;
  for (const name of ['claude', 'codex']) {
    const file = path.join(binDir, name);
    await writeFile(file, script(name));
    await chmod(file, 0o755);
  }
}

class App {
  constructor({ bundle, dataDir, fixtureBin, logFile }) {
    this.bundle = bundle;
    this.dataDir = dataDir;
    this.logFile = logFile;
    this.env = {
      ...process.env,
      PIXEL_AGENTS_DATA_DIR: dataDir,
      // GUI launches get a minimal PATH; only the fixture CLIs are added to it.
      PATH: `${fixtureBin}:/usr/bin:/bin`,
    };
    this.instanceFile = path.join(dataDir, 'desktop', 'instance.json');
  }
  async start() {
    if (await portOpen(CDP_PORT))
      throw new Error(`Port ${CDP_PORT} is already in use (another dev build running?)`);
    const out = await import('node:fs').then((fs) => fs.openSync(this.logFile, 'a'));
    this.child = spawn(path.join(this.bundle, 'bin', 'launcher'), [], {
      cwd: os.tmpdir(), // outside the repository
      env: this.env,
      detached: true,
      stdio: ['ignore', out, out],
    });
    this.exited = new Promise((resolve) => this.child.once('exit', resolve));
    this.instance = await waitFor(
      'the app to publish its hook registration',
      async () => {
        const parsed = JSON.parse(await readFile(this.instanceFile, 'utf8'));
        return alive(parsed.pid) && parsed.port > 0 ? parsed : undefined;
      },
      { timeout: 60_000 },
    );
    return this.instance;
  }
  async connect() {
    this.browser = await waitFor(
      'the CEF DevTools endpoint',
      () => chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`),
      { timeout: 30_000, interval: 500 },
    );
    const context = this.browser.contexts()[0];
    await context.addInitScript(() => {
      window.__PIXEL_AGENTS_E2E = true;
    });
    this.page = await waitFor('the main view', () =>
      context.pages().find((page) => page.url().startsWith('views://')),
    );
    await this.page.reload();
    await this.page.waitForFunction(
      () =>
        window.__pixelAgentsTestHooks?.getCharacters && window.__pixelAgentsTestHooks?.transport,
      null,
      { timeout: 30_000 },
    );
    return this.page;
  }
  characters() {
    return this.page.evaluate(() =>
      window.__pixelAgentsTestHooks.getCharacters().filter((character) => !character.isGreeter),
    );
  }
  send(message) {
    return this.page.evaluate((m) => window.__pixelAgentsTestHooks.transport.send(m), message);
  }
  async screenshot(file) {
    await this.page?.screenshot({ path: file }).catch(() => undefined);
  }
  /**
   * Signals ONLY the runtime process, as an OS shutdown would, so child-process cleanup is the
   * app's own doing. The process group is killed afterwards purely to keep the machine clean and
   * to report a shutdown that did not complete on its own.
   */
  async stop() {
    await this.browser?.close().catch(() => undefined);
    if (!this.child) return { graceful: true };
    const runtimePid = this.instance?.pid ?? this.child.pid;
    if (alive(runtimePid)) {
      try {
        process.kill(runtimePid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
    const graceful = await Promise.race([
      waitFor('the runtime to exit', () => !alive(runtimePid), {
        timeout: 15_000,
        interval: 100,
      }).then(
        () => true,
        () => false,
      ),
    ]);
    await sleep(1_000);
    // Observed BEFORE any cleanup of ours, so it reflects only what the app itself terminated.
    const survivors = pgrep(FIXTURE_SLEEP);
    try {
      process.kill(-this.child.pid, 'SIGKILL');
    } catch {
      /* group already gone */
    }
    for (const pid of survivors)
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    return { graceful, survivors };
  }
}

const pgrep = (pattern) => {
  const result = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' });
  return result.stdout
    .split('\n')
    .filter(Boolean)
    .map(Number)
    .filter((pid) => pid !== process.pid);
};

/**
 * Production artifacts must not expose test surfaces. Launches the app with an isolated profile and
 * checks only what a production build offers: it starts, publishes its hook listener, answers
 * health, opens NO DevTools port, and exits cleanly on request.
 */
async function productionSmoke(bundle) {
  const runDir = await mkdtemp(path.join(os.tmpdir(), 'pixel-agents-smoke-prod-'));
  const dataDir = path.join(runDir, 'home', '.pixel-agents');
  await mkdir(dataDir, { recursive: true });
  await writeFixtures(path.join(runDir, 'bin'), path.join(runDir, 'provider.log'));
  const app = new App({
    bundle,
    dataDir,
    fixtureBin: path.join(runDir, 'bin'),
    logFile: path.join(runDir, 'app.log'),
  });
  try {
    const instance = await app.start();
    const health = await fetch(`http://127.0.0.1:${instance.port}/api/health`);
    check('production build starts and answers /api/health', health.ok);
    await sleep(2_000);
    check('production build opens no DevTools/CDP port', !(await portOpen(CDP_PORT)));
    const stopped = await app.stop();
    check('production build exits gracefully', stopped.graceful);
    check('hook listener is closed after exit', !(await portOpen(instance.port)));
    console.log(`\nProduction smoke passed (${results.length} checks). Artifacts: ${runDir}`);
    if (!flag('--keep')) await rm(runDir, { recursive: true, force: true });
    return 0;
  } catch (error) {
    console.error(`\nProduction smoke FAILED: ${error.message}\nLogs kept in ${runDir}`);
    await app.stop().catch(() => undefined);
    return 1;
  }
}

async function main() {
  const artifact = path.resolve(option('--artifact', 'build/dev-linux-x64'));
  const bundle = await findBundle(artifact);
  if (flag('--production')) return productionSmoke(bundle);
  const runDir = await mkdtemp(path.join(os.tmpdir(), 'pixel-agents-smoke-'));
  const fakeHome = path.join(runDir, 'home');
  const dataDir = path.join(fakeHome, '.pixel-agents');
  const workspace = path.join(runDir, 'workspace');
  const fixtureBin = path.join(runDir, 'bin');
  const providerLog = path.join(runDir, 'provider-invocations.log');
  await mkdir(workspace, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFixtures(fixtureBin, providerLog);
  const helper = path.join(bundle, 'Resources', 'app', 'hooks', 'pixel-agents-hook');
  await stat(helper);
  console.log(`Smoke run directory: ${runDir}`);

  const app1 = new App({ bundle, dataDir, fixtureBin, logFile: path.join(runDir, 'app-run1.log') });
  let current = app1;
  try {
    // ── Run 1: launch, renderer, helper-driven hooks, saves, graceful quit ─────────────
    const instance = await app1.start();
    const health = await fetch(`http://127.0.0.1:${instance.port}/api/health`);
    check('hook server answers /api/health', health.ok);
    const page = await app1.connect();
    check(
      'renderer is served from views://',
      page.url().startsWith('views://mainview/'),
      page.url(),
    );

    const canvasColors = await waitFor(
      'the office canvas to paint',
      () =>
        page.evaluate(() => {
          const canvas = document.querySelector('canvas');
          if (!canvas) return 0;
          const probe = document.createElement('canvas');
          probe.width = 64;
          probe.height = 64;
          const ctx = probe.getContext('2d');
          ctx.drawImage(canvas, 0, 0, 64, 64);
          const data = ctx.getImageData(0, 0, 64, 64).data;
          const seen = new Set();
          for (let i = 0; i < data.length; i += 4)
            seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
          return seen.size > 8 ? seen.size : 0;
        }),
      { timeout: 30_000 },
    );
    check(
      'office renders with bundled assets (not a blank canvas)',
      canvasColors > 8,
      `${canvasColors} colors`,
    );

    const sendHook = (provider, payload) =>
      new Promise((resolve, reject) => {
        const child = spawn(helper, ['--provider', provider], {
          env: { PATH: '/usr/bin:/bin', HOME: fakeHome, USERPROFILE: fakeHome },
          stdio: ['pipe', 'ignore', 'ignore'],
        });
        child.once('error', reject);
        child.once('exit', (code) =>
          code === 0 ? resolve() : reject(new Error(`helper exit ${code}`)),
        );
        child.stdin.end(JSON.stringify(payload));
      });
    const projectA = path.join(runDir, 'project-a');
    const projectB = path.join(runDir, 'project-b');
    await mkdir(projectA);
    await mkdir(projectB);
    // The same session id in both providers must not collide.
    const transcript = path.join(runDir, 'transcript.jsonl');
    await writeFile(
      transcript,
      [
        JSON.stringify({ type: 'user', content: 'Hello from the smoke test' }),
        JSON.stringify({
          type: 'assistant',
          content: [{ type: 'text', text: 'Conversation history works' }],
        }),
      ].join('\n') + '\n', // a complete last line, as real transcripts have
    );
    await sendHook('claude', {
      session_id: 'shared',
      hook_event_name: 'SessionStart',
      cwd: projectA,
      transcript_path: transcript,
    });
    await sendHook('codex', { session_id: 'shared', event: 'SessionStart', cwd: projectB });
    await waitFor(
      'two characters (one per provider)',
      async () => (await app1.characters()).length === 2,
    );
    check('same session id in two providers yields two characters', true);
    const providers = (await app1.characters()).map((c) => c.providerId).sort();
    check(
      'each character is marked with its provider (Claude vs Codex)',
      providers.join() === 'claude,codex',
      providers.join(),
    );
    await page.screenshot({ path: path.join(runDir, 'providers.png') });

    // Selecting an agent opens its conversation drawer with the transcript history.
    const claudeId = (await app1.characters()).find((c) => c.providerId === 'claude').id;
    await page.evaluate((id) => window.__pixelAgentsTestHooks.openConversation(id), claudeId);
    const drawerText = () =>
      page.evaluate(
        () => document.querySelector('.conversation-drawer')?.textContent ?? 'NO DRAWER',
      );
    let shown = '';
    try {
      await waitFor('the conversation drawer to show the history', async () => {
        shown = await drawerText();
        return shown.includes('Conversation history works');
      });
    } catch (error) {
      throw new Error(`${error.message}; the drawer showed: ${shown.slice(0, 160)}`);
    }
    check('selecting an agent opens its conversation drawer with the transcript', true);
    await page.evaluate(() => document.querySelector('.conversation-close')?.click());

    // The office is fitted to the window on load and again on resize.
    const viewport = () => page.evaluate(() => window.__pixelAgentsTestHooks.getViewport());
    const fitted = await viewport();
    check(
      'office is fitted on load: a fine zoom step, not the old fixed 6x',
      fitted.zoom !== 6 && fitted.zoom % 0.25 === 0,
      `${fitted.zoom}x`,
    );
    // CDP cannot resize the native window under CEF, so the page viewport is overridden instead:
    // it drives the same ResizeObserver path a real window resize does.
    const cdp = await page.context().newCDPSession(page);
    const size = await page.evaluate(() => ({
      w: innerWidth,
      h: innerHeight,
      dpr: devicePixelRatio,
    }));
    const setViewport = (w, h) =>
      cdp.send('Emulation.setDeviceMetricsOverride', {
        width: w,
        height: h,
        deviceScaleFactor: size.dpr,
        mobile: false,
      });
    await setViewport(Math.round(size.w * 0.6), Math.round(size.h * 0.6));
    const refit = await waitFor(
      'the office to refit after a resize',
      async () => {
        const v = await viewport();
        return v.zoom < fitted.zoom ? v : undefined;
      },
      { timeout: 10_000 },
    );
    check(
      'office refits when the window shrinks',
      refit.zoom < fitted.zoom && refit.zoom % 0.25 === 0,
      `${fitted.zoom}x -> ${refit.zoom}x`,
    );
    await page.screenshot({ path: path.join(runDir, 'after-resize.png') });
    await setViewport(size.w, size.h);
    await waitFor(
      'the office to refit after growing back',
      async () => (await viewport()).zoom === fitted.zoom,
      { timeout: 10_000 },
    );
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    check('office refits when the window grows back to the same fit', true);

    // Dismissing the "Instant Detection Active" tip is remembered by the host.
    await app1.send({ type: 'setHooksInfoShown' });
    const configFile = path.join(dataDir, 'desktop', 'config.json');
    await waitFor(
      'the dismissed tip to be saved',
      async () => JSON.parse(await readFile(configFile, 'utf8')).settings.hooksInfoShown === true,
    );
    check('dismissing the Instant Detection tip persists', true);

    // A renderer reload (twice) re-bootstraps from the host without losing or duplicating agents.
    for (const round of [1, 2]) {
      await page.reload();
      await page.waitForFunction(() => window.__pixelAgentsTestHooks?.getCharacters, null, {
        timeout: 30_000,
      });
      await waitFor(
        `two characters after reload ${round}`,
        async () => (await app1.characters()).length === 2,
        { timeout: 15_000 },
      );
    }
    check(
      'agents survive renderer reloads without duplicates',
      (await app1.characters()).length === 2,
    );
    const tipGone = await page.evaluate(
      () => !document.body.innerText.includes('Instant Detection Active'),
    );
    check('the dismissed tip stays dismissed after a reload', tipGone);

    await sendHook('claude', {
      session_id: 'shared',
      hook_event_name: 'PermissionRequest',
      cwd: projectA,
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    await waitFor('a permission bubble', async () =>
      (await app1.characters()).some((character) => character.bubbleType === 'permission'),
    );
    check('helper-delivered permission request reaches the renderer', true);

    // Real request/response round trips through Electroview RPC.
    const layout = await page.evaluate(() =>
      fetch('views://mainview/assets/default-layout-2.json').then((r) => r.json()),
    );
    check('bundled assets are fetchable through views://', layout && layout.cols > 0);
    layout.smokeMarker = 'run1';
    await app1.send({ type: 'saveLayout', layout });
    const characters = await app1.characters();
    await app1.send({
      type: 'saveAgentSeats',
      seats: Object.fromEntries(
        characters.map((c, i) => [c.id, { palette: i, hueShift: 0, seatId: `seat-${i}` }]),
      ),
    });
    const statePath = path.join(dataDir, 'desktop', 'state.json');
    const layoutPath = path.join(dataDir, 'desktop', 'layout.json');
    await waitFor('layout and seats to be durable', async () => {
      const saved = JSON.parse(await readFile(layoutPath, 'utf8'));
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      return saved.layout?.smokeMarker === 'run1' && Object.keys(state.seats ?? {}).length === 2;
    });
    check('saveLayout and saveAgentSeats persist through the real RPC path', true);

    const stopped = await app1.stop();
    check('app exits gracefully on SIGTERM', stopped.graceful);
    check(
      'hook registration is released on exit',
      !existsSync(app1.instanceFile) || !alive(instance.pid),
    );
    check('hook listener is closed after exit', !(await portOpen(instance.port)));
    const logText = await readFile(
      path.join(dataDir, 'desktop', 'logs', 'pixel-agents.log'),
      'utf8',
    );
    check('the app wrote a structured log', /"message":"\[Desktop\] Starting"/.test(logText));
    check('the log never contains the hook token', !logText.includes(instance.token));
    const windowState = JSON.parse(
      await readFile(path.join(dataDir, 'desktop', 'window.json'), 'utf8'),
    );
    check(
      'window bounds were persisted',
      windowState.schemaVersion === 1 && windowState.bounds.width >= 800,
    );
    const state1 = JSON.parse(await readFile(statePath, 'utf8'));
    const surnames = state1.agents.map((a) => a.displayName.split(' ')[1]);
    check(
      'agent surnames come from their folders, not a shared "Workspace"',
      surnames.join() === 'Projecta,Projectb',
      surnames.join(),
    );
    check('both agents were persisted', state1.agents.length === 2, `${state1.agents.length}`);

    // ── Run 2: restart persistence, managed launch, second instance, process cleanup ───
    // A native folder picker cannot be automated, so the workspace is added to the config the
    // picker would have written.
    const configPath = path.join(dataDir, 'desktop', 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.settings.workspaces = [
      { id: 'smoke-workspace', path: workspace, label: 'smoke-workspace' },
    ];
    await writeFile(configPath, JSON.stringify(config, null, 2));

    const app2 = new App({
      bundle,
      dataDir,
      fixtureBin,
      logFile: path.join(runDir, 'app-run2.log'),
    });
    current = app2;
    const instance2 = await app2.start();
    const page2 = await app2.connect();
    await waitFor('restored characters', async () => (await app2.characters()).length === 2);
    check('agents are restored after restart', true);
    const saved = JSON.parse(await readFile(layoutPath, 'utf8'));
    check(
      'custom layout survives restart (not replaced by a bundled default)',
      saved.layout?.smokeMarker === 'run1',
    );

    await app2.send({ type: 'launchAgent', folderPath: workspace });
    await waitFor(
      'the managed provider process',
      async () =>
        existsSync(providerLog) &&
        /^claude .*--session-id/m.test(await readFile(providerLog, 'utf8')),
      { timeout: 20_000 },
    );
    check('managed launch spawns the provider CLI with a session id', true);
    check('fixture descendant is running', pgrep(FIXTURE_SLEEP).length > 0);

    // A second launch on the same profile must hand off and exit, not start a second runtime.
    const second = spawn(path.join(bundle, 'bin', 'launcher'), [], {
      cwd: os.tmpdir(),
      env: { ...app2.env },
      detached: true,
      stdio: 'ignore',
    });
    const secondExit = await Promise.race([
      new Promise((resolve) => second.once('exit', () => resolve(true))),
      sleep(20_000).then(() => false),
    ]);
    try {
      process.kill(-second.pid, 'SIGKILL');
    } catch {
      /* exited */
    }
    check('a second launch exits instead of starting another runtime', secondExit);
    const after = JSON.parse(await readFile(app2.instanceFile, 'utf8'));
    check(
      'the first instance still owns the profile',
      after.pid === instance2.pid && alive(after.pid),
    );

    await page2.screenshot({ path: path.join(runDir, 'final.png') });
    const stopped2 = await app2.stop();
    check('second run exits gracefully', stopped2.graceful);
    check(
      'the app terminates provider descendants on shutdown',
      stopped2.survivors.length === 0,
      stopped2.survivors.join(','),
    );
    check('hook listener is closed after second exit', !(await portOpen(instance2.port)));
    check('CDP port is released', !(await portOpen(CDP_PORT)));
    await writeFile(
      path.join(runDir, 'smoke-result.json'),
      JSON.stringify({ ok: true, results }, null, 2),
    );
    console.log(`\nDesktop smoke passed (${results.length} checks). Artifacts: ${runDir}`);
    if (!flag('--keep')) await rm(runDir, { recursive: true, force: true });
    return 0;
  } catch (error) {
    console.error(`\nDesktop smoke FAILED: ${error.message}`);
    await current.screenshot(path.join(runDir, 'failure.png'));
    await current.stop().catch(() => undefined);
    for (const pid of pgrep(FIXTURE_SLEEP))
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    await writeFile(
      path.join(runDir, 'smoke-result.json'),
      JSON.stringify({ ok: false, error: error.message, results }, null, 2),
    );
    console.error(`Logs, result JSON and screenshot kept in ${runDir}`);
    return 1;
  }
}

process.exit(await main());
