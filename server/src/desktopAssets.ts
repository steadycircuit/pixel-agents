import { createHash } from 'node:crypto';

import type { AssetChunk, AssetId } from '../../core/src/desktop/types.js';
import { ASSET_IDS } from '../../core/src/desktop/types.js';
import type { AssetCache } from './clientMessageHandler.js';

/** Characters per RPC chunk: keeps each JSON response small and bounded. */
export const ASSET_CHUNK_CHARS = 256 * 1024;

export interface AssetCatalog {
  /** Identifier of exactly this decoded asset set; changes whenever any asset changes. */
  readonly version: string;
  chunk(assetId: AssetId, chunkIndex: number): AssetChunk | undefined;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function payloadFor(cache: AssetCache, assetId: AssetId): unknown {
  switch (assetId) {
    case 'characters':
      return cache.characters?.characters ?? [];
    case 'pets':
      return cache.pets
        ? { pets: cache.pets.pets, petNames: cache.pets.manifests.map((m) => m.name) }
        : { pets: [], petNames: [] };
    case 'floors':
      return cache.floorTiles ?? [];
    case 'walls':
      return cache.wallTiles ?? [];
    case 'carpets':
      return cache.carpetTiles ?? [];
    case 'furniture':
      return cache.furniture
        ? { catalog: cache.furniture.catalog, sprites: Object.fromEntries(cache.furniture.sprites) }
        : { catalog: [], sprites: {} };
    case 'defaultLayout':
      return cache.defaultLayout;
  }
}

/** Serializes a decoded asset cache once. The catalog is immutable: a reload builds a new one. */
export function createAssetCatalog(cache: AssetCache): AssetCatalog {
  const serialized = new Map<AssetId, { json: string; hash: string }>();
  for (const assetId of ASSET_IDS) {
    const json = JSON.stringify(payloadFor(cache, assetId) ?? null);
    serialized.set(assetId, { json, hash: sha256(json) });
  }
  const version = sha256([...serialized.values()].map((entry) => entry.hash).join(':'));
  return {
    version,
    chunk(assetId, chunkIndex) {
      const entry = serialized.get(assetId);
      if (!entry || !Number.isSafeInteger(chunkIndex) || chunkIndex < 0) return undefined;
      const chunkCount = Math.max(1, Math.ceil(entry.json.length / ASSET_CHUNK_CHARS));
      if (chunkIndex >= chunkCount) return undefined;
      return {
        chunk: entry.json.slice(
          chunkIndex * ASSET_CHUNK_CHARS,
          (chunkIndex + 1) * ASSET_CHUNK_CHARS,
        ),
        chunkIndex,
        chunkCount,
        sha256: entry.hash,
      };
    },
  };
}

/** Version reported before any catalog has been built. Requests naming it are always stale. */
export const EMPTY_CATALOG_VERSION = 'none';
