/**
 * `pnpm content:build [--out <dir>]`: builds the current content version into
 * `<out>/<version>/` and points `<out>/latest.json` at it. `--out` defaults to `dist/`.
 *
 * `builtAt` is the last commit's time (or `SOURCE_DATE_EPOCH`), not the clock, so building the
 * same commit twice gives byte-identical output; CI diffs two builds to prove it.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { BudgetError, buildContent } from './lib/build';
import { readIcons } from './lib/icons';
import { stableStringify } from './lib/json';
import { DIST_DIR, ROOT, readConfig } from './lib/repo';

const { values } = parseArgs({ options: { out: { type: 'string' } } });
const out = values.out ? resolve(values.out) : DIST_DIR;

function builtAt(): string {
  const epoch = process.env.SOURCE_DATE_EPOCH;
  if (epoch) return new Date(Number(epoch) * 1000).toISOString();
  const committed = execFileSync('git', ['log', '-1', '--format=%cI'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return new Date(committed.trim()).toISOString();
}

const config = await readConfig();
let result: Awaited<ReturnType<typeof buildContent>>;
try {
  result = await buildContent(config, await readIcons(), builtAt());
} catch (err) {
  if (err instanceof BudgetError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

const versionDir = join(out, result.version);
await rm(versionDir, { recursive: true, force: true });
for (const [path, bytes] of result.files) {
  const file = join(versionDir, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, bytes);
}
await writeFile(join(out, 'latest.json'), stableStringify({ version: result.version }, true));

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
const biggest = [...result.floorSizes].sort((a, b) => b.gzip - a.gzip)[0];
console.log(`Built ${result.version}: ${result.files.size} files in ${versionDir}`);
if (biggest)
  console.log(`Largest floor: ${biggest.name}, ${kb(biggest.gzip)} gzipped (budget 150 KB)`);
