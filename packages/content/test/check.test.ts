import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadBaseline } from '../scripts/lib/baseline';
import { type Catalogues, checkCatalogues, checkMap, checkStability } from '../scripts/lib/check';
import { extractMap } from '../scripts/lib/extract';
import { readMapSources } from '../scripts/lib/repo';
import type { MapData } from '../src/schema';

async function tinyMap(): Promise<MapData> {
  const { meta, sources } = await readMapSources(join(import.meta.dirname, 'fixtures', 'tiny'));
  return (await extractMap(meta, sources)).map;
}

const withoutWall = (map: MapData, id: string): MapData => ({
  ...map,
  walls: map.walls.filter((w) => w.id !== id),
});

describe('checkStability', () => {
  it('fails when a released wall id is gone and no migration mentions it', async () => {
    const released = await tinyMap();
    const problems = checkStability(withoutWall(released, 'wall:1f:lab-north'), released, {});
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^wall:1f:lab-north was in the last release and is gone/);
  });

  it('passes when the removed wall has a migration entry', async () => {
    const released = await tinyMap();
    const current = withoutWall(released, 'wall:1f:lab-north');
    expect(checkStability(current, released, { 'wall:1f:lab-north': null })).toEqual([]);
  });

  it('fails when a migration renames a wall to an id that does not exist', async () => {
    const released = await tinyMap();
    const current = withoutWall(released, 'wall:1f:lab-north');
    expect(checkStability(current, released, { 'wall:1f:lab-north': 'wall:1f:nowhere' })).toEqual([
      "migration maps wall:1f:lab-north to wall:1f:nowhere, which doesn't exist",
    ]);
  });

  it('treats hatches like walls', async () => {
    const released = await tinyMap();
    const problems = checkStability({ ...released, hatches: [] }, released, {});
    expect(problems[0]).toMatch(/^hatch:1f:lab was in the last release/);
  });
});

describe('loadBaseline', () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it('reads the latest release from a folder laid out like the bucket', async () => {
    dir = await mkdtemp(join(tmpdir(), 'planted-baseline-'));
    const map = await tinyMap();
    await mkdir(join(dir, 'y11s3.1', 'maps', 'tiny'), { recursive: true });
    await writeFile(join(dir, 'latest.json'), JSON.stringify({ version: 'y11s3.1' }));
    await writeFile(join(dir, 'y11s3.1', 'maps', 'tiny', 'map.abc.json'), JSON.stringify(map));
    await writeFile(
      join(dir, 'y11s3.1', 'manifest.json'),
      JSON.stringify({
        version: 'y11s3.1',
        builtAt: '2026-10-26T00:00:00.000Z',
        maps: [{ id: 'tiny', name: 'Tiny', map: 'maps/tiny/map.json', thumb: 't', floors: [] }],
        upcoming: [],
        files: { 'maps/tiny/map.json': 'maps/tiny/map.abc.json' },
      }),
    );
    const baseline = await loadBaseline(dir);
    expect(baseline?.version).toBe('y11s3.1');
    expect(baseline?.maps.get('tiny')?.walls.map((w) => w.id)).toContain('wall:1f:lab-north');
  });

  it('is null before the first release', async () => {
    dir = await mkdtemp(join(tmpdir(), 'planted-baseline-'));
    expect(await loadBaseline(dir)).toBeNull();
  });
});

describe('checkMap', () => {
  it('accepts the tiny fixture', async () => {
    expect(checkMap(await tinyMap()).problems).toEqual([]);
  });

  it('flags a room outline that crosses itself', async () => {
    const map = await tinyMap();
    const bowtie = {
      ...map.rooms[0],
      polygon: [
        [0.1, 0.1],
        [0.2, 0.2],
        [0.2, 0.1],
        [0.1, 0.2],
      ],
    };
    const problems = checkMap({ ...map, rooms: [bowtie, ...map.rooms.slice(1)] }).problems;
    expect(problems).toEqual(['room:1f:lab outline crosses itself (edges 0 and 2)']);
  });

  it('flags an objective whose room does not exist', async () => {
    const map = await tinyMap();
    const site = map.sites[0] as MapData['sites'][number];
    const moved = { ...site, objectives: [{ ...site.objectives[0], roomId: 'room:1f:attic' }] };
    expect(checkMap({ ...map, sites: [moved] }).problems).toEqual([
      "site:lab A: room room:1f:attic doesn't exist",
    ]);
  });

  it('flags a wall endpoint outside the map through the schema', async () => {
    const map = await tinyMap();
    const wall = { ...map.walls[0], to: [1.2, 0.5] };
    expect(checkMap({ ...map, walls: [wall] }).problems).toEqual([
      'walls.0.to.0: Too big: expected number to be <=1',
    ]);
  });
});

describe('checkCatalogues', () => {
  const make = (overrides: Partial<Catalogues> = {}): Catalogues => ({
    operators: [
      {
        id: 'ash',
        name: 'Ash',
        side: 'attack',
        badge: 'AS',
        roles: ['entry'],
        uniqueGadget: { gadgetId: 'breaching-rounds', count: 2 },
        secondaryGadgetOptions: ['breach-charge'],
        weaponClasses: ['ar'],
        seasonAdded: 'y0s0',
      },
    ],
    gadgets: [
      {
        id: 'breach-charge',
        name: 'Breach Charge',
        side: 'attack',
        placement: 'wall',
        defaultCount: 3,
        iconId: 'breach-charge',
        unique: false,
      },
      {
        id: 'barbed-wire',
        name: 'Barbed Wire',
        side: 'defence',
        placement: 'floor',
        defaultCount: 2,
        iconId: 'barbed-wire',
        unique: false,
      },
      {
        id: 'breaching-rounds',
        name: 'Breaching Rounds',
        side: 'attack',
        placement: 'wall',
        defaultCount: 2,
        iconId: 'unique',
        unique: true,
      },
    ],
    weaponClasses: [{ id: 'ar', name: 'Assault rifle', iconId: 'weapon-ar' }],
    rules: { teamSize: 5, reinforcementsPerDefender: 2, dronesPerAttacker: 2 },
    ...overrides,
  });
  const icons = new Set(['breach-charge', 'barbed-wire', 'unique', 'weapon-ar']);

  it('accepts catalogues whose references all resolve', () => {
    expect(checkCatalogues(make(), icons)).toEqual([]);
  });

  it('flags an operator secondary that does not exist', () => {
    const base = make();
    const [ash] = base.operators as Record<string, unknown>[];
    const operators = [{ ...ash, secondaryGadgetOptions: ['frag-grenade'] }];
    expect(checkCatalogues({ ...base, operators }, icons)).toEqual([
      "operators.json: ash secondary frag-grenade doesn't exist",
    ]);
  });

  it('flags a secondary from the other side', () => {
    const base = make();
    const [ash] = base.operators as Record<string, unknown>[];
    const operators = [{ ...ash, secondaryGadgetOptions: ['barbed-wire'] }];
    expect(checkCatalogues({ ...base, operators }, icons)).toEqual([
      "operators.json: ash (attack) can't take barbed-wire (defence)",
    ]);
  });

  it('flags an icon id with no source SVG', () => {
    const missing = new Set([...icons].filter((i) => i !== 'weapon-ar'));
    expect(checkCatalogues(make(), missing)).toEqual([
      'weapon-classes.json: ar icon weapon-ar has no icons/src/weapon-ar.svg',
    ]);
  });
});
