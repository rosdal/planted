import { Latest, Manifest, MapData } from '@planted/content';
import type { z } from 'zod';

/**
 * Content from the CDN (packages/content, built per version). Every version folder is
 * immutable, so a manifest or map is fetched once per page and kept in memory; only
 * `latest.json` changes, and the landing page alone reads it. Rooms always load the version
 * they pinned at creation.
 */

export class ContentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ContentError';
  }
}

export function contentBase(): string {
  const base = import.meta.env.VITE_CONTENT_URL;
  if (!base) throw new ContentError('VITE_CONTENT_URL is not configured');
  return base.replace(/\/$/, '');
}

/** Absolute URL of a file inside a version folder. */
export function contentUrl(version: string, path: string): string {
  return `${contentBase()}/${version}/${path}`;
}

async function fetchJson<T>(url: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (cause) {
    throw new ContentError('Could not reach the map server', { cause });
  }
  if (!res.ok) throw new ContentError(`${url} answered ${res.status}`);
  const parsed = schema.safeParse(await res.json().catch(() => null));
  if (!parsed.success)
    throw new ContentError(`${url} is not valid content`, { cause: parsed.error });
  return parsed.data;
}

/** The newest released version. Cached for 60 s by the CDN; never by us. */
export async function loadLatest(): Promise<string> {
  const { version } = await fetchJson(`${contentBase()}/latest.json`, Latest);
  return version;
}

const manifests = new Map<string, Promise<Manifest>>();

export function loadManifest(version: string): Promise<Manifest> {
  let pending = manifests.get(version);
  if (!pending) {
    pending = fetchJson(contentUrl(version, 'manifest.json'), Manifest);
    // A failed load isn't cached, so a retry fetches again.
    pending.catch(() => manifests.delete(version));
    manifests.set(version, pending);
  }
  return pending;
}

/** Resolves a manifest's logical name (`maps/bank/map.json`) to its hashed URL. */
export function fileOf(manifest: Manifest, logical: string): string {
  const path = manifest.files[logical];
  if (!path) throw new ContentError(`${manifest.version} has no ${logical}`);
  return contentUrl(manifest.version, path);
}

export type LoadedMap = {
  version: string;
  map: MapData;
  /** Floor id → absolute URL of its display SVG. */
  floorArt: Record<string, string>;
  /** Pixi spritesheet JSON of the version's icons, at 1× (64 px) and 2× (128 px); null if none. */
  iconAtlas: { x1: string; x2: string } | null;
};

const maps = new Map<string, Promise<LoadedMap>>();

export function loadMap(version: string, mapId: string): Promise<LoadedMap> {
  const key = `${version}/${mapId}`;
  let pending = maps.get(key);
  if (!pending) {
    pending = (async () => {
      const manifest = await loadManifest(version);
      const entry = manifest.maps.find((m) => m.id === mapId);
      if (!entry) throw new ContentError(`Content ${version} has no map ${mapId}`);
      const map = await fetchJson(fileOf(manifest, entry.map), MapData);
      // After build, each floor's `art` is its hashed path inside the version folder.
      const floorArt = Object.fromEntries(
        map.floors.map((f) => [f.id, contentUrl(version, f.art)]),
      );
      const iconAtlas =
        manifest.files['icons/atlas-64.json'] && manifest.files['icons/atlas-128.json']
          ? {
              x1: fileOf(manifest, 'icons/atlas-64.json'),
              x2: fileOf(manifest, 'icons/atlas-128.json'),
            }
          : null;
      return { version, map, floorArt, iconAtlas };
    })();
    pending.catch(() => maps.delete(key));
    maps.set(key, pending);
  }
  return pending;
}

const sprites = new Map<string, Promise<string>>();

/** The icon sprite's SVG text for a version. */
export function loadSprite(version: string): Promise<string> {
  let pending = sprites.get(version);
  if (!pending) {
    pending = loadManifest(version).then(async (manifest) => {
      const res = await fetch(fileOf(manifest, 'icons/sprite.svg'));
      if (!res.ok) throw new ContentError(`icon sprite answered ${res.status}`);
      return res.text();
    });
    pending.catch(() => sprites.delete(version));
    sprites.set(version, pending);
  }
  return pending;
}
