import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ContentConfig as Config, ContentConfig } from '../../src/schema';
import type { FloorSource } from './extract';

/** `packages/content`. */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MAPS_DIR = join(ROOT, 'maps');
export const ICONS_DIR = join(ROOT, 'icons', 'src');
export const DIST_DIR = join(ROOT, 'dist');

export const rel = (path: string) => relative(ROOT, path).replaceAll('\\', '/');

export async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function readConfig(root = ROOT): Promise<Config> {
  return ContentConfig.parse(await readJson(join(root, 'content.json')));
}

export const contentVersion = (config: Config) => `${config.season}.${config.build}`;

/** `meta.json` and every `src/<floorId>.svg` of one map. */
export async function readMapSources(
  mapDir: string,
): Promise<{ meta: unknown; sources: FloorSource[] }> {
  const metaPath = join(mapDir, 'meta.json');
  if (!existsSync(metaPath)) throw new Error(`${rel(metaPath)} is missing`);
  const srcDir = join(mapDir, 'src');
  const files = existsSync(srcDir) ? (await readdir(srcDir)).filter((f) => f.endsWith('.svg')) : [];
  const sources = await Promise.all(
    files.sort().map(async (f) => ({
      floorId: f.replace(/\.svg$/, ''),
      file: rel(join(srcDir, f)),
      svg: await readFile(join(srcDir, f), 'utf8'),
    })),
  );
  return { meta: await readJson(metaPath), sources };
}
