import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd();

// 1. Materialize the pinned SDK devkit (`.hutch/devkit`). The renderer build and the type-checks
// import from it, so it must exist on a clean checkout before either runs. Idempotent and quick.
const launcher = path.join(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electrobun.cmd' : 'electrobun',
);
if (!existsSync(launcher)) {
  console.error('electrobun is not installed; install dependencies first (bun install / npm ci).');
  process.exit(1);
}
const prepared = spawnSync(launcher, ['prepare'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (prepared.status !== 0) {
  console.error('`electrobun prepare` failed; the SDK devkit could not be created.');
  process.exit(prepared.status ?? 1);
}
if (!existsSync(path.join(root, '.hutch', 'devkit', 'api', 'browser', 'index.ts'))) {
  console.error('`electrobun prepare` finished but .hutch/devkit is missing.');
  process.exit(1);
}

// 2. Build metadata consumed by the native package.
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const generated = path.join(root, 'desktop', 'generated');
await mkdir(generated, { recursive: true });
await writeFile(
  path.join(generated, 'buildInfo.ts'),
  `export const APP_VERSION = ${JSON.stringify(pkg.version)} as const;\n`,
);
console.log(`Desktop metadata prepared for Pixel Agents ${pkg.version}`);
