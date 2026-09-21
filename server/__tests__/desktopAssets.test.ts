import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { ASSET_IDS } from '../../core/src/desktop/types.js';
import { buildAssetCache } from '../src/assetReload.js';
import { ASSET_CHUNK_CHARS, createAssetCatalog } from '../src/desktopAssets.js';
import { createProviderRegistry } from '../src/providerRegistry.js';
import { claudeProvider, codexProvider } from '../src/providers/index.js';
import { createRuntimeHost } from '../src/runtimeHost.js';

const bundledRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../webview-ui/public',
);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function reassemble(
  catalog: ReturnType<typeof createAssetCatalog>,
  assetId: (typeof ASSET_IDS)[number],
) {
  const first = catalog.chunk(assetId, 0)!;
  let json = first.chunk;
  for (let index = 1; index < first.chunkCount; index++)
    json += catalog.chunk(assetId, index)!.chunk;
  return { json, first };
}

describe('desktop asset catalog', () => {
  it('serves every bundled asset as bounded chunks that reassemble to valid JSON', async () => {
    const catalog = createAssetCatalog(await buildAssetCache(bundledRoot, []));
    for (const assetId of ASSET_IDS) {
      const { json, first } = reassemble(catalog, assetId);
      expect(first.chunk.length).toBeLessThanOrEqual(ASSET_CHUNK_CHARS);
      expect(() => JSON.parse(json)).not.toThrow();
    }
    const characters = JSON.parse(reassemble(catalog, 'characters').json);
    expect(characters.length).toBeGreaterThanOrEqual(6);
    const furniture = JSON.parse(reassemble(catalog, 'furniture').json);
    expect(furniture.catalog.length).toBeGreaterThan(0);
    expect(Object.keys(furniture.sprites).length).toBeGreaterThan(0);
    expect(JSON.parse(reassemble(catalog, 'defaultLayout').json)).toMatchObject({ version: 1 });
  });

  it('is deterministic, and its version changes when an asset changes', async () => {
    const cache = await buildAssetCache(bundledRoot, []);
    const a = createAssetCatalog(cache);
    expect(createAssetCatalog(cache).version).toBe(a.version);
    const b = createAssetCatalog({ ...cache, floorTiles: [[['floor-b']]] });
    expect(b.version).not.toBe(a.version);
  });

  it('rejects unknown assets and out-of-range or non-integer chunk indexes', async () => {
    const catalog = createAssetCatalog(await buildAssetCache(bundledRoot, []));
    expect(catalog.chunk('nope' as never, 0)).toBeUndefined();
    expect(catalog.chunk('floors', -1)).toBeUndefined();
    expect(catalog.chunk('floors', 1.5)).toBeUndefined();
    expect(catalog.chunk('floors', 10_000)).toBeUndefined();
  });

  it('serves an empty but well-formed catalog when nothing is bundled', () => {
    const catalog = createAssetCatalog({
      characters: null,
      pets: null,
      floorTiles: null,
      wallTiles: null,
      carpetTiles: null,
      furniture: null,
      defaultLayout: null,
    });
    for (const assetId of ASSET_IDS) expect(catalog.chunk(assetId, 0)?.chunkCount).toBe(1);
  });
});

describe('runtime host asset access', () => {
  it('reports a catalog version and rejects stale versions', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pixel-host-assets-'));
    roots.push(root);
    const host = createRuntimeHost({
      profileRoot: path.join(root, 'desktop'),
      assetRoot: bundledRoot,
      hookToken: 't',
      providers: createProviderRegistry([claudeProvider, codexProvider], async () => ({
        executable: process.execPath,
        version: 'test',
      })),
    });
    const snapshot = await host.start();
    try {
      expect(snapshot.catalogVersion).toMatch(/^[0-9a-f]{64}$/);
      expect(host.getAssetChunk(snapshot.catalogVersion, 'floors', 0).chunkIndex).toBe(0);
      expect(() => host.getAssetChunk('old', 'floors', 0)).toThrow('STALE_CLIENT');
      expect(() => host.getAssetChunk(snapshot.catalogVersion, 'floors', 99999)).toThrow(
        'NOT_FOUND',
      );
    } finally {
      await host.stop('test');
    }
  });
});
