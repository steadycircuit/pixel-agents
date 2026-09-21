import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd();
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const generated = path.join(root, 'desktop', 'generated');
await mkdir(generated, { recursive: true });
await writeFile(
  path.join(generated, 'buildInfo.ts'),
  `export const APP_VERSION = ${JSON.stringify(pkg.version)} as const;\n`,
);
console.log(`Desktop metadata prepared for Pixel Agents ${pkg.version}`);
