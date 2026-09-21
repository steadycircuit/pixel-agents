import { chmod, mkdir, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expectedBunVersion = '1.4.2';
const bunVersion = spawnSync('bun', ['--version'], { encoding: 'utf8' });
if (bunVersion.status !== 0 || bunVersion.stdout.trim() !== expectedBunVersion) {
  throw new Error(
    `Standalone hook helpers require Bun ${expectedBunVersion}; found ${bunVersion.stdout.trim() || 'none'}`,
  );
}
const destination = path.join(root, 'dist', 'desktop-hooks');
await mkdir(destination, { recursive: true });
const suffix = process.platform === 'win32' ? '.exe' : '';
const output = path.join(destination, `pixel-agents-hook${suffix}`);
const build = spawnSync(
  'bun',
  [
    'build',
    path.join(root, 'server', 'src', 'providers', 'hook', 'desktopHookHelper.ts'),
    '--compile',
    '--outfile',
    output,
  ],
  { cwd: root, encoding: 'utf8' },
);
if (build.status !== 0)
  throw new Error(build.stderr || 'Bun could not compile the standalone hook helper');
if (!(await stat(output)).isFile()) throw new Error(`Missing compiled hook helper: ${output}`);
if (process.platform !== 'win32') await chmod(output, 0o700);
console.log(`Standalone hook helper built with Bun ${expectedBunVersion}: ${output}`);
