#!/usr/bin/env node
/**
 * Builds Pixel Agents and installs it on THIS Ubuntu machine.
 *
 *   bun deploy:ubuntu                 # everything
 *   bun deploy:ubuntu -- --dry-run    # print the plan, change nothing
 *   bun deploy:ubuntu -- --skip-deps --skip-build   # just (re)install the last build
 *
 * Steps: system libraries -> npm dependencies -> desktop build -> installer -> install.
 * Dependencies are installed with `bun install --no-save`: package.json is the source of truth and
 * neither bun.lock nor package-lock.json is rewritten (both can lag behind package.json).
 * The install writes to ~/.local/share/com.pixelagents.desktop and ~/.local/share/applications,
 * and the installer starts the app when it finishes.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const skip = {
  system: args.has('--skip-system-deps'),
  deps: args.has('--skip-deps'),
  build: args.has('--skip-build'),
};
const EXPECTED_BUN = '1.4.2'; // scripts/build-hook-helper.mjs refuses any other version

/**
 * CEF still needs the GTK/AppIndicator/librsvg runtime libraries. Names differ between Ubuntu
 * releases, so each entry lists alternatives; the first one apt knows is used.
 */
const SYSTEM_PACKAGES = [
  ['libgtk-3-0t64', 'libgtk-3-0'],
  ['libwebkit2gtk-4.1-0', 'libwebkit2gtk-4.0-37'],
  ['libayatana-appindicator3-1', 'libappindicator3-1'],
  ['librsvg2-common'],
  ['zstd'],
];

const log = (message) => console.log(`\n\x1b[1m▶ ${message}\x1b[0m`);
const note = (message) => console.log(`  ${message}`);
function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m`);
  process.exit(1);
}

function run(command, commandArgs, options = {}) {
  note(`$ ${[command, ...commandArgs].join(' ')}`);
  if (dryRun) return { status: 0 };
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit', ...options });
  if (result.status !== 0)
    fail(
      `\`${[command, ...commandArgs].join(' ')}\` failed (exit ${result.status ?? result.signal}).`,
    );
  return result;
}
const capture = (command, commandArgs) => spawnSync(command, commandArgs, { encoding: 'utf8' });

// ── Preflight ─────────────────────────────────────────────────────────────────
log('Checking this machine');
if (process.platform !== 'linux') fail('deploy:ubuntu only runs on Linux.');
const osRelease = existsSync('/etc/os-release') ? readFileSync('/etc/os-release', 'utf8') : '';
if (!/^ID(_LIKE)?=.*(ubuntu|debian)/m.test(osRelease))
  console.warn(
    '  ⚠ This does not look like Ubuntu/Debian; continuing, but package names may differ.',
  );
if (process.env.XDG_SESSION_TYPE) note(`session: ${process.env.XDG_SESSION_TYPE}`);
if (!skip.build) {
  const bun = capture('bun', ['--version']);
  if (bun.status !== 0 || bun.stdout.trim() !== EXPECTED_BUN)
    fail(
      `The build needs Bun ${EXPECTED_BUN} on PATH (it compiles the hook helper); found ${bun.stdout.trim() || 'none'}.`,
    );
  note(`bun ${EXPECTED_BUN} ✓`);
}
if (dryRun) note('DRY RUN: nothing below is executed.');

// ── 1. System libraries ───────────────────────────────────────────────────────
if (!skip.system) {
  log('System libraries (CEF runtime)');
  const missing = [];
  for (const alternatives of SYSTEM_PACKAGES) {
    const installed = alternatives.find((name) =>
      capture('dpkg-query', ['-W', '-f=${Status}', name]).stdout?.includes('install ok installed'),
    );
    if (installed) {
      note(`${installed} ✓`);
      continue;
    }
    const available = alternatives.find((name) => {
      const policy = capture('apt-cache', ['policy', name]).stdout ?? '';
      return policy.includes('Candidate:') && !policy.includes('Candidate: (none)');
    });
    if (available) missing.push(available);
    else
      console.warn(
        `  ⚠ none of [${alternatives.join(', ')}] found in apt; skipping (the app may still run)`,
      );
  }
  if (missing.length) {
    note(`installing: ${missing.join(' ')} (sudo may ask for your password)`);
    run('sudo', ['apt-get', 'install', '-y', ...missing]);
  }
}

// ── 2. Dependencies ───────────────────────────────────────────────────────────
if (!skip.deps) {
  log('Installing dependencies (bun install --no-save; lockfiles are left untouched)');
  run('bun', ['install', '--no-save']);
}

// ── 3. Build ──────────────────────────────────────────────────────────────────
if (!skip.build) {
  log('Building the desktop app and installer (this takes a few minutes)');
  run('npm', ['run', 'desktop:build']);
}

// ── 4. Find the installer ─────────────────────────────────────────────────────
log('Locating the installer');
const artifacts = path.join(root, 'artifacts');
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const installerArchive = existsSync(artifacts)
  ? readdirSync(artifacts).find((name) => name === `linux-${arch}-PixelAgents-Setup.tar.gz`)
  : undefined;
if (!installerArchive && !dryRun)
  fail(`No linux-${arch}-PixelAgents-Setup.tar.gz in ${artifacts}. Run without --skip-build.`);
note(installerArchive ? path.join(artifacts, installerArchive) : '(will exist after the build)');

// ── 5. Stop a running copy (an install over a running app is not safe) ───────
log('Checking for a running Pixel Agents');
const instanceFile = path.join(os.homedir(), '.pixel-agents', 'desktop', 'instance.json');
let runningPid;
try {
  const { pid } = JSON.parse(readFileSync(instanceFile, 'utf8'));
  // Only ever the exact process the app recorded for itself, and only if it really is Pixel Agents.
  const exe = existsSync(`/proc/${pid}/exe`) ? readlinkSync(`/proc/${pid}/exe`) : '';
  if (Number.isInteger(pid) && exe.includes('com.pixelagents.desktop')) runningPid = pid;
} catch {
  /* no instance file: nothing is running */
}
if (runningPid) {
  note(`Pixel Agents is running (pid ${runningPid}); asking it to quit so it can be replaced.`);
  if (!dryRun) {
    process.kill(runningPid, 'SIGTERM');
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && existsSync(`/proc/${runningPid}`)) spawnSync('sleep', ['0.25']);
    if (existsSync(`/proc/${runningPid}`))
      fail(`Pixel Agents (pid ${runningPid}) did not quit. Close it and run this again.`);
    note('stopped ✓ (its data in ~/.pixel-agents is kept)');
  }
} else {
  note('not running ✓');
}

// ── 6. Install ────────────────────────────────────────────────────────────────
log('Installing to ~/.local/share/com.pixelagents.desktop');
if (dryRun) {
  note('$ tar xzf <installer archive> -C <temp dir> && <temp dir>/installer');
} else {
  const staging = mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-install-'));
  try {
    run('tar', ['xzf', path.join(artifacts, installerArchive), '-C', staging]);
    run(path.join(staging, 'installer'), [], { cwd: staging });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

log('Done');
note('Pixel Agents is installed and starting. Launch it later from the app grid ("Pixel Agents"),');
note('or run: ~/.local/share/com.pixelagents.desktop/stable/app/bin/launcher');
note(
  'If the icon looks generic at first, log out and back in so GNOME rereads the launcher entry.',
);
