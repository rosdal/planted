/**
 * `pnpm content:extract [mapId…]`: floor SVGs + meta.json → map.json, display art, and the
 * bundled map summary. With no ids, extracts every map in content.json.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { MapData } from '../src/schema';
import { ExtractError } from './lib/extract';
import { extractOne, mapOutputs, summaryOutput } from './lib/outputs';
import { readConfig, rel } from './lib/repo';

const config = await readConfig();
const requested = process.argv.slice(2);
for (const id of requested) {
  if (!config.maps.includes(id)) {
    console.error(`${id} is not in content.json "maps"`);
    process.exit(1);
  }
}

let failed = false;
const extracted: MapData[] = [];
// The summary needs every map, so all are extracted; only the requested ones are reported.
for (const id of config.maps) {
  try {
    const result = await extractOne(id);
    extracted.push(result.map);
    if (requested.length > 0 && !requested.includes(id)) continue;
    for (const [path, content] of mapOutputs(id, result)) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    }
    const m = result.map;
    console.log(
      `${id}: ${m.floors.length} floors, ${m.rooms.length} rooms, ${m.walls.length} walls, ` +
        `${m.hatches.length} hatches, ${m.openings.length} openings, ${m.sites.length} sites`,
    );
  } catch (err) {
    failed = true;
    if (err instanceof ExtractError) {
      console.error(`${id}: ${err.problems.length} problem(s)`);
      for (const p of err.problems) console.error(`  ${p}`);
    } else {
      console.error(`${id}:`, err);
    }
  }
}
if (failed) process.exit(1);

for (const [path, content] of summaryOutput(config, extracted)) {
  await writeFile(path, content);
  console.log(`wrote ${rel(path)}`);
}
