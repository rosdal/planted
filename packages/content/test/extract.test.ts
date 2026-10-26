import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExtractError, extractMap, type FloorSource } from '../scripts/lib/extract';
import { stableStringify } from '../scripts/lib/json';
import { readMapSources } from '../scripts/lib/repo';

const TINY = join(import.meta.dirname, 'fixtures', 'tiny');

async function tiny() {
  return readMapSources(TINY);
}

/** The fixture floor with `edit` applied to its SVG text. */
async function tinyWith(
  edit: (svg: string) => string,
): Promise<{ meta: unknown; sources: FloorSource[] }> {
  const { meta, sources } = await tiny();
  return { meta, sources: sources.map((s) => ({ ...s, svg: edit(s.svg) })) };
}

async function problemsOf(input: { meta: unknown; sources: FloorSource[] }): Promise<string[]> {
  try {
    await extractMap(input.meta, input.sources);
  } catch (err) {
    if (err instanceof ExtractError) return err.problems;
    throw err;
  }
  throw new Error('expected the extractor to fail');
}

describe('extractMap', () => {
  it('accepts the floor template, so new floors start from something that extracts', async () => {
    const svg = await readFile(join(import.meta.dirname, '..', 'templates', 'floor.svg'), 'utf8');
    const meta = {
      id: 'template',
      name: 'Template',
      contentRev: 'y11s3',
      floors: [{ id: '1f', label: '1F', order: 1 }],
      sites: { example: { name: 'Example' } },
    };
    const { map } = await extractMap(meta, [{ floorId: '1f', file: 'floor.svg', svg }]);
    expect(map.walls).toHaveLength(4);
    expect(map.sites[0]?.objectives.map((o) => o.roomId)).toEqual([
      'room:1f:example-west',
      'room:1f:example-east',
    ]);
  });

  it('turns the tiny fixture into the expected map.json, byte for byte', async () => {
    const { meta, sources } = await tiny();
    const { map } = await extractMap(meta, sources);
    const expected = await readFile(join(TINY, 'expected-map.json'), 'utf8');
    expect(stableStringify(map, true)).toBe(expected.replaceAll('\r\n', '\n'));
  });

  it('exports the art layer alone, without data layers or editor attributes', async () => {
    const { meta, sources } = await tiny();
    const { art } = await extractMap(meta, sources);
    const svg = art['1f'] ?? '';
    expect(svg).toContain('viewBox="0 0 4096 4096"');
    // svgo strips unused ids, so a leaked data layer shows up as extra shapes, not as ids. The
    // fixture's art is one rect and one path; every hatch, objective and spawn is a circle.
    expect(svg.match(/<path\b/g)).toHaveLength(2);
    expect(svg).not.toMatch(/<circle|data-|inkscape/);
  });

  it('names the wall when data-kind is missing', async () => {
    const input = await tinyWith((svg) => svg.replace(' data-kind="soft"', ''));
    expect(await problemsOf(input)).toEqual([
      'test/fixtures/tiny/src/1f.svg: wall:1f:office-south has no data-kind',
    ]);
  });

  it('names a room whose outline is not closed', async () => {
    const input = await tinyWith((svg) =>
      svg.replace('d="M1024 1024H2048V2048H1024Z"', 'd="M1024 1024H2048V2048H1024"'),
    );
    expect(await problemsOf(input)).toEqual([
      'test/fixtures/tiny/src/1f.svg: room:lab is not closed (end its path with Z)',
    ]);
  });

  it('names an id used twice', async () => {
    const input = await tinyWith((svg) =>
      svg.replace('id="wall:1f:lab-north"', 'id="wall:1f:lab-office"'),
    );
    expect(await problemsOf(input)).toEqual([
      'test/fixtures/tiny/src/1f.svg: wall:1f:lab-office is used more than once',
    ]);
  });

  it('rejects a wall that claims another floor', async () => {
    const input = await tinyWith((svg) => svg.replace('wall:1f:lab-north', 'wall:2f:lab-north'));
    expect(await problemsOf(input)).toEqual([
      'test/fixtures/tiny/src/1f.svg: wall:2f:lab-north is in test/fixtures/tiny/src/1f.svg but names floor 2f',
    ]);
  });

  it('reports a missing data layer', async () => {
    const input = await tinyWith((svg) => svg.replace('<g id="openings"/>', ''));
    expect(await problemsOf(input)).toEqual([
      'test/fixtures/tiny/src/1f.svg: no layer (group id) "openings"',
    ]);
  });
});
