import { mkdir, cp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'webview-ui', 'public', 'assets');
const destination = path.join(root, 'dist', 'desktop-assets');
const hooksDestination = path.join(root, 'dist', 'desktop-hooks');
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });
await rm(hooksDestination, { recursive: true, force: true });
await mkdir(hooksDestination, { recursive: true });

// Transitional packaging: these are the existing compatibility hooks. Desktop
// owns a separate destination so a future compiled helper can replace them
// without touching the extension's build outputs.
for (const entry of [
  path.join(root, 'server', 'src', 'providers', 'hook', 'claude', 'hooks', 'claude-hook.ts'),
  path.join(root, 'server', 'src', 'providers', 'hook', 'codex', 'hooks', 'codex-hook.ts'),
]) {
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile: path.join(hooksDestination, `${path.basename(entry, '.ts')}.js`),
    banner: { js: '#!/usr/bin/env node' },
  });
}

const helperBuild = spawnSync(
  process.execPath,
  [path.join(root, 'scripts', 'build-hook-helper.mjs')],
  {
    cwd: root,
    encoding: 'utf8',
  },
);
if (helperBuild.status !== 0)
  throw new Error(helperBuild.stderr || 'Failed to build standalone hook helper');
process.stdout.write(helperBuild.stdout);
const files = [];
const walk = async (dir) => {
  for (const entry of await (
    await import('node:fs/promises')
  ).readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(file);
    else {
      const bytes = await (await import('node:fs/promises')).readFile(file);
      files.push({
        path: path.relative(destination, file).split(path.sep).join('/'),
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.byteLength,
      });
    }
  }
};
await walk(destination);
await writeFile(
  path.join(destination, 'resource-manifest.json'),
  `${JSON.stringify({ schemaVersion: 1, files }, null, 2)}\n`,
);
