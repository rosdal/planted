import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Resvg } from '@resvg/resvg-js';
import { type PackerExporterType, packAsync } from 'free-tex-packer-core';
import sharp from 'sharp';
import { type ContentConfig, type Manifest, MapData } from '../../src/schema';
import { type IconSource, optimizeIcon } from './icons';
import { stableStringify } from './json';
import { contentVersion, MAPS_DIR, ROOT, readJson } from './repo';

/** Gzipped size limit per floor SVG; the build fails over it. */
export const FLOOR_BUDGET_BYTES = 150 * 1024;
export const THUMB_PX = 1024;
/** Icon raster sizes for the Pixi atlases: 64 px at 1×, 128 px for high-density screens. */
export const ATLAS_SIZES = [64, 128] as const;
/** Thumbnails show the white art on the board's dark background, in both themes. */
const THUMB_BACKGROUND = '#16181d';

export type BuildOutput = {
  version: string;
  /** Path relative to the version folder → bytes. Includes `manifest.json`. */
  files: Map<string, Buffer>;
  /** Gzipped size of each floor SVG, for the report. */
  floorSizes: { name: string; gzip: number }[];
};

export class BudgetError extends Error {}

const hash = (bytes: Buffer | string) =>
  createHash('sha256').update(bytes).digest('hex').slice(0, 12);

/**
 * Builds one content version in memory. Deterministic: the same sources and `builtAt` give
 * byte-identical files, because JSON keys are sorted, floats were rounded at extraction, and the
 * PNG/WebP encoders are given fixed settings.
 */
export async function buildContent(
  config: ContentConfig,
  icons: IconSource[],
  builtAt: string,
): Promise<BuildOutput> {
  const version = contentVersion(config);
  const files = new Map<string, Buffer>();
  /** Logical name → hashed path. */
  const names: Record<string, string> = {};
  const add = (logical: string, bytes: Buffer, ext: string) => {
    const dot = logical.lastIndexOf('.');
    const path = `${logical.slice(0, dot)}.${hash(bytes)}${ext}`;
    files.set(path, bytes);
    names[logical] = path;
    return path;
  };

  const floorSizes: BuildOutput['floorSizes'] = [];
  const maps: Manifest['maps'] = [];
  for (const id of config.maps) {
    const dir = join(MAPS_DIR, id);
    const map = MapData.parse(await readJson(join(dir, 'map.json')));
    const floors: MapData['floors'] = [];
    for (const floor of map.floors) {
      const svg = await readFile(join(dir, floor.art));
      const gzip = gzipSync(svg, { level: 9 }).byteLength;
      const logical = `maps/${id}/${floor.id}.svg`;
      floorSizes.push({ name: logical, gzip });
      if (gzip > FLOOR_BUDGET_BYTES) {
        throw new BudgetError(
          `${logical} is ${(gzip / 1024).toFixed(1)} KB gzipped, over the ${FLOOR_BUDGET_BYTES / 1024} KB budget`,
        );
      }
      floors.push({ ...floor, art: add(logical, svg, '.svg') });
    }
    const thumbFloor = map.floors.find((f) => f.order === 1) ?? map.floors[0];
    if (!thumbFloor) throw new Error(`${id} has no floors`);
    const thumb = await renderThumb(await readFile(join(dir, thumbFloor.art), 'utf8'));
    add(`maps/${id}/thumb.webp`, thumb, '.webp');
    const built = { ...map, floors };
    add(`maps/${id}/map.json`, Buffer.from(stableStringify(built)), '.json');
    maps.push({
      id,
      name: map.name,
      map: `maps/${id}/map.json`,
      thumb: `maps/${id}/thumb.webp`,
      floors: floors.map((f) => ({ id: f.id, label: f.label, art: `maps/${id}/${f.id}.svg` })),
    });
  }

  for (const name of ['operators', 'gadgets', 'weapon-classes', 'rules']) {
    const data = await readJson(join(ROOT, `${name}.json`));
    add(`catalogues/${name}.json`, Buffer.from(stableStringify(data)), '.json');
  }

  const optimized = icons.map((icon) => ({ id: icon.id, svg: optimizeIcon(icon.svg) }));
  add('icons/sprite.svg', Buffer.from(sprite(optimized)), '.svg');
  for (const size of ATLAS_SIZES) {
    const { json, png } = await atlas(optimized, size);
    const image = add(`icons/atlas-${size}.png`, png, '.png');
    // The JSON names its image relative to itself; both live in icons/.
    const sheet = { ...json, meta: { ...json.meta, image: image.slice('icons/'.length) } };
    add(`icons/atlas-${size}.json`, Buffer.from(stableStringify(sheet)), '.json');
  }

  const manifest: Manifest = {
    version,
    builtAt,
    maps,
    upcoming: config.upcoming,
    files: Object.fromEntries(Object.entries(names).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
  files.set('manifest.json', Buffer.from(stableStringify(manifest, true)));
  return { version, files, floorSizes };
}

async function renderThumb(svg: string): Promise<Buffer> {
  const png = new Resvg(svg, {
    fitTo: { mode: 'width', value: THUMB_PX },
    background: THUMB_BACKGROUND,
    font: { loadSystemFonts: false },
  })
    .render()
    .asPng();
  return sharp(png).webp({ quality: 82, effort: 6 }).toBuffer();
}

/** One `<symbol id="icon-<id>">` per icon, carrying the root's stroke settings. */
export function sprite(icons: IconSource[]): string {
  const symbols = icons.map(({ id, svg }) => {
    const root = /^<svg\b([^>]*)>/.exec(svg);
    if (!root) throw new Error(`icon ${id} has no <svg> root`);
    const attrs = (root[1] ?? '').replace(/\s*xmlns="[^"]*"/, '');
    const body = svg.slice(root[0].length).replace(/<\/svg>\s*$/, '');
    return `<symbol id="icon-${id}"${attrs}>${body}</symbol>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg">${symbols.join('')}</svg>`;
}

type SpritesheetJson = {
  frames: Record<string, unknown>;
  meta: Record<string, unknown> & { image: string };
};

/** Every icon rasterised in white at `size` px and packed into one Pixi spritesheet. */
async function atlas(
  icons: IconSource[],
  size: number,
): Promise<{ json: SpritesheetJson; png: Buffer }> {
  const images = icons.map(({ id, svg }) => ({
    path: `${id}.png`,
    contents: new Resvg(svg.replaceAll('currentColor', '#ffffff'), {
      fitTo: { mode: 'width', value: size },
      font: { loadSystemFonts: false },
    })
      .render()
      .asPng(),
  }));
  const result = await packAsync(images, {
    textureName: `atlas-${size}`,
    // The typings declare a TS enum the JS never exports; its value is this string.
    exporter: 'JsonHash' as PackerExporterType,
    width: 2048,
    height: 2048,
    padding: 2,
    extrude: 1,
    allowRotation: false,
    allowTrim: false,
    detectIdentical: false,
    removeFileExtension: true,
    prependFolderName: false,
  });
  const json = result.find((f) => f.name.endsWith('.json'));
  const png = result.find((f) => f.name.endsWith('.png'));
  if (!json || !png || result.length !== 2) throw new Error('icon atlas did not fit one page');
  const parsed = JSON.parse(json.buffer.toString('utf8')) as SpritesheetJson;
  // Frames are in logical (64 px) units on the 128 px sheet, so Pixi draws both the same size.
  parsed.meta = {
    ...parsed.meta,
    app: 'planted',
    version: '1',
    scale: String(size / ATLAS_SIZES[0]),
  };
  // The packer's PNG encoder is not ours to pin; re-encode so the bytes depend only on pixels.
  const normalized = await sharp(png.buffer)
    .png({ compressionLevel: 9, palette: false })
    .toBuffer();
  return { json: parsed, png: normalized };
}
