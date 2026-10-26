import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Latest, Manifest, MapData } from '../../src/schema';

/**
 * The last released map data, read from a content root (the bucket's public URL, or a local
 * folder laid out the same way: `latest.json`, `<version>/manifest.json`, …). Null when the root
 * has no release yet, which is the case before the first `content-v*` tag.
 */
export async function loadBaseline(
  root: string,
): Promise<{ version: string; maps: Map<string, MapData> } | null> {
  const remote = /^https?:\/\//.test(root);
  const read = async (path: string): Promise<unknown | null> => {
    if (remote) {
      const res = await fetch(new URL(path, root.endsWith('/') ? root : `${root}/`));
      if (res.status === 404 || res.status === 403) return null;
      if (!res.ok) throw new Error(`GET ${path} from ${root}: ${res.status}`);
      return res.json();
    }
    const file = join(root, path);
    return existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : null;
  };
  const latest = await read('latest.json');
  if (latest === null) return null;
  const { version } = Latest.parse(latest);
  const manifest = Manifest.parse(await read(`${version}/manifest.json`));
  const maps = new Map<string, MapData>();
  for (const entry of manifest.maps) {
    const file = manifest.files[entry.map];
    if (!file) throw new Error(`manifest ${version} has no file for ${entry.map}`);
    maps.set(entry.id, MapData.parse(await read(`${version}/${file}`)));
  }
  return { version, maps };
}
