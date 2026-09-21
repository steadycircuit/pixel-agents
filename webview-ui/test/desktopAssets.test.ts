import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { describe, test } from 'vitest';

import type { AssetChunk, AssetId } from '../../core/src/desktop/types.js';
import { loadCatalog } from '../src/transport/desktopAssets.js';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

function catalogOf(overrides: Partial<Record<AssetId, unknown>> = {}, chunkSize = 8) {
  const payloads: Record<AssetId, unknown> = {
    characters: [{ down: [], up: [], right: [] }],
    pets: { pets: [], petNames: [] },
    floors: [[['floor-a']]],
    walls: [],
    carpets: [],
    furniture: { catalog: [{ id: 'DESK' }], sprites: { DESK: [['desk-a']] } },
    defaultLayout: { version: 1 },
    ...overrides,
  };
  const requests: Array<[AssetId, number]> = [];
  const fetchChunk = async (assetId: AssetId, chunkIndex: number): Promise<AssetChunk> => {
    requests.push([assetId, chunkIndex]);
    const json = JSON.stringify(payloads[assetId]);
    const chunkCount = Math.max(1, Math.ceil(json.length / chunkSize));
    return {
      chunk: json.slice(chunkIndex * chunkSize, (chunkIndex + 1) * chunkSize),
      chunkIndex,
      chunkCount,
      sha256: sha(json),
    };
  };
  return { fetchChunk, requests };
}

describe('loadCatalog', () => {
  test('reassembles multi-chunk assets and orders messages as the office requires', async () => {
    const { fetchChunk, requests } = catalogOf();
    const loaded = await loadCatalog(fetchChunk);
    assert.deepEqual(
      loaded.messages.map((message) => message.type),
      [
        'characterSpritesLoaded',
        'floorTilesLoaded',
        'wallTilesLoaded',
        'carpetTilesLoaded',
        'furnitureAssetsLoaded',
      ],
    );
    assert.deepEqual(loaded.defaultLayout, { version: 1 });
    assert.ok(
      requests.some(([, index]) => index > 0),
      'multi-chunk assets were paged',
    );
    const furniture = loaded.messages.at(-1);
    assert.ok(furniture && furniture.type === 'furnitureAssetsLoaded');
    assert.deepEqual(furniture.sprites, { DESK: [['desk-a']] });
  });

  test('sends pets only when the catalog has some', async () => {
    const loaded = await loadCatalog(
      catalogOf({ pets: { pets: [{ walkDown: [] }], petNames: ['Claudio'] } }).fetchChunk,
    );
    const pets = loaded.messages.find((message) => message.type === 'petSpritesLoaded');
    assert.ok(pets && pets.type === 'petSpritesLoaded');
    assert.deepEqual(pets.petNames, ['Claudio']);
    assert.equal(loaded.messages[1]?.type, 'petSpritesLoaded');
  });

  test('fails when an asset changes between chunks', async () => {
    const { fetchChunk } = catalogOf();
    const flaky = async (assetId: AssetId, index: number) => {
      const chunk = await fetchChunk(assetId, index);
      return index > 0 ? { ...chunk, sha256: 'different' } : chunk;
    };
    await assert.rejects(loadCatalog(flaky), /changed while loading/);
  });

  test('fails on a corrupted payload and on an absurd chunk count', async () => {
    const { fetchChunk } = catalogOf();
    await assert.rejects(
      loadCatalog(async (assetId, index) => {
        const chunk = await fetchChunk(assetId, index);
        return index === 0 ? { ...chunk, chunk: `x${chunk.chunk.slice(1)}` } : chunk;
      }),
    );
    await assert.rejects(
      loadCatalog(async (assetId, index) => ({
        ...(await fetchChunk(assetId, index)),
        chunkCount: 1_000_000,
      })),
      /invalid chunk count/,
    );
  });

  test('propagates a stale-catalog failure so the caller can restart bootstrap', async () => {
    await assert.rejects(
      loadCatalog(async () => {
        throw new Error('STALE_CLIENT');
      }),
      /STALE_CLIENT/,
    );
  });
});
