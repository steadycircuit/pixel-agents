import type { AssetChunk, AssetId } from '../../../core/src/desktop/types.js';
import type { ServerMessage } from '../../../core/src/messages.js';

export type FetchAssetChunk = (assetId: AssetId, chunkIndex: number) => Promise<AssetChunk>;

export interface LoadedCatalog {
  /** Asset messages in the order the office requires: sprites, tiles, furniture. */
  messages: ServerMessage[];
  defaultLayout: unknown;
}

/** Upper bound on chunks per asset: a corrupt `chunkCount` must not become an unbounded loop. */
const MAX_CHUNKS = 512;

async function digest(text: string): Promise<string | undefined> {
  // `views://` may not be a secure context; without SubtleCrypto the hash check is skipped
  // (the chunk-count and JSON parse checks still catch truncation).
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return undefined;
  const bytes = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function fetchAsset(fetchChunk: FetchAssetChunk, assetId: AssetId): Promise<unknown> {
  const first = await fetchChunk(assetId, 0);
  if (
    !Number.isSafeInteger(first.chunkCount) ||
    first.chunkCount < 1 ||
    first.chunkCount > MAX_CHUNKS
  )
    throw new Error(`Asset ${assetId} reported an invalid chunk count`);
  const parts = [first.chunk];
  for (let index = 1; index < first.chunkCount; index++) {
    const next = await fetchChunk(assetId, index);
    if (next.chunkCount !== first.chunkCount || next.sha256 !== first.sha256)
      throw new Error(`Asset ${assetId} changed while loading`);
    parts.push(next.chunk);
  }
  const json = parts.join('');
  const actual = await digest(json);
  if (actual !== undefined && actual !== first.sha256)
    throw new Error(`Asset ${assetId} failed its integrity check`);
  return JSON.parse(json) as unknown;
}

export async function loadCatalog(fetchChunk: FetchAssetChunk): Promise<LoadedCatalog> {
  const [characters, pets, floors, walls, carpets, furniture, defaultLayout] = await Promise.all([
    fetchAsset(fetchChunk, 'characters'),
    fetchAsset(fetchChunk, 'pets'),
    fetchAsset(fetchChunk, 'floors'),
    fetchAsset(fetchChunk, 'walls'),
    fetchAsset(fetchChunk, 'carpets'),
    fetchAsset(fetchChunk, 'furniture'),
    fetchAsset(fetchChunk, 'defaultLayout'),
  ]);
  const petData = pets as { pets: unknown[]; petNames: string[] };
  const furnitureData = furniture as { catalog: unknown[]; sprites: Record<string, string[][]> };
  const messages = [
    { type: 'characterSpritesLoaded', characters },
    ...(petData.pets.length > 0
      ? [{ type: 'petSpritesLoaded', pets: petData.pets, petNames: petData.petNames }]
      : []),
    { type: 'floorTilesLoaded', sprites: floors },
    { type: 'wallTilesLoaded', sets: walls },
    { type: 'carpetTilesLoaded', sets: carpets },
    {
      type: 'furnitureAssetsLoaded',
      catalog: furnitureData.catalog,
      sprites: furnitureData.sprites,
    },
  ] as ServerMessage[];
  return { messages, defaultLayout };
}
