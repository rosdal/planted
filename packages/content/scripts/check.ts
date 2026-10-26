/**
 * `pnpm content:check [--baseline <url or dir>]`: everything CI checks about content.
 *
 * - every map extracts cleanly, and the committed map.json / art / maps.gen.ts are what the
 *   extractor writes now (nobody hand-edited them, nobody forgot to re-extract)
 * - every map.json is schema-valid with unique ids, sane rooms and resolvable objectives
 * - wall and hatch ids still exist since the last release, or have a migration entry
 * - catalogues are valid and cross-reference, and every icon follows the style spec
 *
 * The baseline defaults to `CONTENT_BASELINE_URL`; without one the stability check is skipped
 * with a notice, which is expected until the first release.
 */
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { IdMigration, type MapData } from '../src/schema';
import { loadBaseline } from './lib/baseline';
import { checkCatalogues, checkMap, checkStability } from './lib/check';
import { ExtractError } from './lib/extract';
import { lintIcon, readIcons } from './lib/icons';
import { extractOne, mapOutputs, summaryOutput } from './lib/outputs';
import { MAPS_DIR, ROOT, readConfig, readJson, rel } from './lib/repo';

const { values } = parseArgs({ options: { baseline: { type: 'string' } } });
const baselineRoot = values.baseline ?? process.env.CONTENT_BASELINE_URL;

const problems: string[] = [];
const config = await readConfig();

const mapDirs = (await readdir(MAPS_DIR, { withFileTypes: true }))
  .filter((d) => d.isDirectory())
  .map((d) => d.name);
for (const dir of mapDirs) {
  if (!config.maps.includes(dir)) problems.push(`maps/${dir} isn't listed in content.json "maps"`);
}

const maps: MapData[] = [];
for (const id of config.maps) {
  let extracted: Awaited<ReturnType<typeof extractOne>>;
  try {
    extracted = await extractOne(id);
  } catch (err) {
    if (!(err instanceof ExtractError)) throw err;
    problems.push(...err.problems.map((p) => `${id}: ${p}`));
    continue;
  }
  if (extracted.map.id !== id) problems.push(`maps/${id}/meta.json has id ${extracted.map.id}`);
  maps.push(extracted.map);
  for (const [path, expected] of mapOutputs(id, extracted)) {
    const actual = existsSync(path) ? await readFile(path, 'utf8') : null;
    if (actual !== expected) problems.push(`${rel(path)} is stale; run pnpm content:extract ${id}`);
  }
  const committed = join(MAPS_DIR, id, 'map.json');
  if (existsSync(committed)) {
    const { problems: mapProblems } = checkMap(await readJson(committed));
    problems.push(...mapProblems.map((p) => `${id}: ${p}`));
  }
}
if (maps.length === config.maps.length) {
  for (const [path, expected] of summaryOutput(config, maps)) {
    const actual = existsSync(path) ? await readFile(path, 'utf8') : null;
    if (actual !== expected) problems.push(`${rel(path)} is stale; run pnpm content:extract`);
  }
}

if (baselineRoot) {
  const baseline = await loadBaseline(baselineRoot);
  if (!baseline) {
    console.log(`No release at ${baselineRoot} yet; skipping the wall-id stability check.`);
  } else {
    for (const map of maps) {
      const before = baseline.maps.get(map.id);
      if (!before) continue;
      const migrations = await readMigrations(map.id);
      problems.push(...checkStability(map, before, migrations).map((p) => `${map.id}: ${p}`));
    }
    console.log(`Wall and hatch ids checked against ${baseline.version}.`);
  }
} else {
  console.log(
    'No baseline (--baseline or CONTENT_BASELINE_URL); skipping the wall-id stability check.',
  );
}

const icons = await readIcons();
for (const icon of icons) problems.push(...lintIcon(icon));
problems.push(
  ...checkCatalogues(
    {
      operators: await readJson(join(ROOT, 'operators.json')),
      gadgets: await readJson(join(ROOT, 'gadgets.json')),
      weaponClasses: await readJson(join(ROOT, 'weapon-classes.json')),
      rules: await readJson(join(ROOT, 'rules.json')),
    },
    new Set(icons.map((i) => i.id)),
  ),
);

if (problems.length > 0) {
  console.error(`content:check found ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`content:check ok: ${maps.length} maps, ${icons.length} icons.`);

/** Every `migrations/*.json` of a map, merged; later revs win on a repeated id. */
async function readMigrations(mapId: string): Promise<IdMigration> {
  const dir = join(MAPS_DIR, mapId, 'migrations');
  if (!existsSync(dir)) return {};
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  const merged: IdMigration = {};
  for (const f of files) Object.assign(merged, IdMigration.parse(await readJson(join(dir, f))));
  return merged;
}
