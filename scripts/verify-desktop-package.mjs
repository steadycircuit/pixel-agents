import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const artifactIndex = process.argv.indexOf('--artifact');
const requested =
  artifactIndex === -1
    ? path.resolve('dist')
    : (process.argv[artifactIndex + 1] ?? path.resolve('dist'));
const isDirectory = async (target) =>
  (await stat(target).catch(() => null))?.isDirectory() ?? false;
let artifact = requested;
// An update archive (`<channel>-<os>-<arch>-<name>.tar.zst`) is the distributable app itself; unpack
// it to a temporary directory and verify that, after checking its update manifest agrees.
if (requested.endsWith('.tar.zst')) {
  const manifestPath = requested.replace(/PixelAgents\.tar\.zst$/, 'update.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.artifact?.file !== path.basename(requested))
    throw new Error(
      `Update manifest names ${manifest.artifact?.file}, not ${path.basename(requested)}`,
    );
  if (manifest.channel !== 'stable') console.warn(`Note: verifying a ${manifest.channel} archive`);
  const target = await mkdtemp(path.join(os.tmpdir(), 'pixel-agents-verify-'));
  const unpack = spawnSync('sh', ['-c', 'zstd -dc "$1" | tar x -C "$2"', 'sh', requested, target], {
    stdio: 'inherit',
  });
  if (unpack.status !== 0)
    throw new Error('Could not unpack the update archive (is zstd installed?)');
  artifact = target;
  console.log(
    `Unpacked ${path.basename(requested)} (${manifest.version}, ${manifest.hash}) to ${target}`,
  );
}
if (!(await isDirectory(path.join(artifact, 'Resources')))) {
  const children = await readdir(artifact, { withFileTypes: true }).catch(() => []);
  const bundle = children.find(
    (entry) => entry.isDirectory() && entry.name.startsWith('PixelAgents'),
  );
  if (bundle) artifact = path.join(artifact, bundle.name);
}

if (await isDirectory(path.join(artifact, 'Resources'))) {
  const app = path.join(artifact, 'Resources', 'app');
  for (const target of [
    path.join(artifact, 'bin', 'cef'),
    path.join(artifact, 'bin', 'cottontail'),
    path.join(app, 'views', 'mainview'),
    path.join(app, 'hooks'),
  ]) {
    if (!(await isDirectory(target)) && !(await stat(target).catch(() => null))?.isFile())
      throw new Error(`Missing packaged resource: ${target}`);
  }
  await access(path.join(app, 'assets', 'resource-manifest.json'));
  await access(path.join(app, 'views', 'mainview', 'index.html'));
  await access(
    path.join(app, 'hooks', `pixel-agents-hook${process.platform === 'win32' ? '.exe' : ''}`),
  );
  // The app icon: bundled next to the runtime, a real PNG, and referenced by the launcher entry so
  // the dock/menu can show it. (The Windows .ico and macOS .icns are produced by their own hosts.)
  if (process.platform === 'linux') {
    const icon = await readFile(path.join(artifact, 'Resources', 'appIcon.png'));
    if (icon.readUInt32BE(0) !== 0x89504e47) throw new Error('Resources/appIcon.png is not a PNG');
    const entry = (await readdir(artifact)).find((name) => name.endsWith('.desktop'));
    if (!entry || !/^Icon=.+/m.test(await readFile(path.join(artifact, entry), 'utf8')))
      throw new Error('The launcher .desktop entry has no Icon= line');
  }
  console.log(`Native desktop package verified: ${artifact}`);
} else {
  for (const name of ['desktop-assets', 'desktop-view', 'desktop-hooks']) {
    if (!(await isDirectory(path.join(artifact, name))))
      throw new Error(`Missing desktop staging directory: ${path.join(artifact, name)}`);
  }
  await access(path.join(artifact, 'desktop-assets', 'resource-manifest.json'));
  await access(
    path.join(
      artifact,
      'desktop-hooks',
      `pixel-agents-hook${process.platform === 'win32' ? '.exe' : ''}`,
    ),
  );
  console.log(`Desktop staging package verified: ${artifact}`);
}
