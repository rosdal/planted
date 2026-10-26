import { optimize } from 'svgo';
import { type INode, parse, stringify } from 'svgson';
import { type MapData, MapMeta, type OpeningKind, WallKind } from '../../src/schema';
import {
  apply,
  flattenPath,
  IDENTITY,
  type Matrix,
  multiply,
  type Pt,
  parseTransform,
  simplify,
} from './geometry';

/** Floor SVGs are drawn on a 4096 × 4096 canvas; map space is that divided by 4096. */
export const CANVAS = 4096;
const VIEWBOX = `0 0 ${CANVAS} ${CANVAS}`;

export const DATA_LAYERS = ['rooms', 'walls', 'hatches', 'openings', 'sites', 'spawns'] as const;
type DataLayer = (typeof DATA_LAYERS)[number];
const LAYERS = new Set<string>(['art', ...DATA_LAYERS]);
const SHAPES = new Set(['path', 'polygon', 'polyline', 'rect', 'line', 'circle', 'ellipse']);

/** Straight runs sampled at 1 unit lose every point closer than this to the line: 0.1 units. */
const SIMPLIFY_EPSILON = 0.1;

const SLUG = '[a-z0-9]+(?:-[a-z0-9]+)*';
const PATTERNS = {
  rooms: new RegExp(`^room:(${SLUG})$`),
  walls: new RegExp(`^wall:(${SLUG}):(${SLUG})$`),
  hatches: new RegExp(`^hatch:(${SLUG}):(${SLUG})$`),
  openings: new RegExp(`^(door|window|vault):(${SLUG}):(${SLUG})$`),
  sites: new RegExp(`^obj:(${SLUG}):(A|B)$`),
  spawns: new RegExp(`^spawn:(attack|defence):(${SLUG})$`),
} satisfies Record<DataLayer, RegExp>;
const EXPECTED: Record<DataLayer, string> = {
  rooms: 'room:<slug>',
  walls: 'wall:<floor>:<slug>',
  hatches: 'hatch:<floor>:<slug>',
  openings: 'door|window|vault:<floor>:<slug>',
  sites: 'obj:<site>:<A or B>',
  spawns: 'spawn:<attack or defence>:<slug>',
};

/** Every problem the extractor found, each naming the file and element it is about. */
export class ExtractError extends Error {
  constructor(readonly problems: string[]) {
    super(`${problems.length} problem(s):\n${problems.map((p) => `  ${p}`).join('\n')}`);
    this.name = 'ExtractError';
  }
}

export type FloorSource = { floorId: string; file: string; svg: string };
export type Extracted = {
  map: MapData;
  /** Display SVG per floor id: the `art` layer alone. */
  art: Record<string, string>;
};

type Shape = { node: INode; matrix: Matrix; layer: DataLayer };

const round = (v: number) => {
  const r = Math.round((v / CANVAS) * 1e5) / 1e5;
  return r === 0 ? 0 : r;
};
const toMap = ([x, y]: Pt): Pt => [round(x), round(y)];
const num = (node: INode, name: string) => Number(node.attributes[name] ?? 0);
const titleCase = (slug: string) =>
  slug
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

/**
 * Turns one map's floor SVGs plus its `meta.json` into `map.json` and per-floor display art.
 * Collects every problem rather than stopping at the first, and throws them together.
 */
export async function extractMap(metaInput: unknown, sources: FloorSource[]): Promise<Extracted> {
  const problems: string[] = [];
  const metaParsed = MapMeta.safeParse(metaInput);
  if (!metaParsed.success) {
    throw new ExtractError(
      metaParsed.error.issues.map(
        (i) => `meta.json: ${i.path.join('.') || '(root)'}: ${i.message}`,
      ),
    );
  }
  const meta = metaParsed.data;
  const byFloor = new Map(sources.map((s) => [s.floorId, s]));
  for (const floor of meta.floors) {
    if (!byFloor.has(floor.id))
      problems.push(`meta.json: floor ${floor.id} has no src/${floor.id}.svg`);
  }
  for (const source of sources) {
    if (!meta.floors.some((f) => f.id === source.floorId)) {
      problems.push(`${source.file}: floor ${source.floorId} is not listed in meta.json`);
    }
  }

  const map: MapData = {
    id: meta.id,
    name: meta.name,
    contentRev: meta.contentRev,
    floors: [...meta.floors]
      .sort((a, b) => a.order - b.order)
      .map((f) => ({ ...f, art: `art/${f.id}.svg` })),
    sites: [],
    rooms: [],
    walls: [],
    hatches: [],
    openings: [],
    spawns: [],
  };
  const art: Record<string, string> = {};
  const objectives = new Map<
    string,
    { floorId: string; label: string; at: Pt; roomId: string }[]
  >();
  /** Element ids seen so far, across floors; rooms are keyed by their floor-qualified id. */
  const seenIds = new Set<string>();

  for (const floor of map.floors) {
    const source = byFloor.get(floor.id);
    if (!source) continue;
    const { file } = source;
    const floorId = floor.id;
    let root: INode;
    try {
      root = await parse(source.svg);
    } catch (err) {
      problems.push(`${file}: not valid SVG (${(err as Error).message})`);
      continue;
    }
    const viewBox = root.attributes.viewBox?.trim().replace(/[\s,]+/g, ' ');
    if (viewBox !== VIEWBOX)
      problems.push(`${file}: viewBox must be "${VIEWBOX}", got "${viewBox}"`);

    const shapes: Shape[] = [];
    let artLayer: INode | null = null;
    const seenLayers = new Set<string>();
    const walk = (node: INode, parent: Matrix, layer: DataLayer | 'art' | null) => {
      if (node.type !== 'element') return;
      let matrix = parent;
      try {
        matrix = multiply(parent, parseTransform(node.attributes.transform));
      } catch (err) {
        problems.push(
          `${file}: ${node.attributes.id ?? `a <${node.name}>`}: ${(err as Error).message}`,
        );
      }
      const id = node.attributes.id;
      if (layer === null && node.name === 'g' && id && LAYERS.has(id)) {
        if (seenLayers.has(id)) problems.push(`${file}: layer ${id} appears twice`);
        seenLayers.add(id);
        if (id === 'art') {
          artLayer = node;
          // Only the art group itself is exported, so a transform above or on it would be lost.
          if (matrix.some((v, i) => v !== IDENTITY[i])) {
            problems.push(`${file}: the art layer must not be transformed`);
          }
          return;
        }
        for (const child of node.children) walk(child, matrix, id as DataLayer);
        return;
      }
      if (layer && layer !== 'art' && SHAPES.has(node.name)) {
        shapes.push({ node, matrix, layer });
        return;
      }
      for (const child of node.children) walk(child, matrix, layer);
    };
    walk(root, IDENTITY, null);
    for (const layer of LAYERS) {
      if (!seenLayers.has(layer)) problems.push(`${file}: no layer (group id) "${layer}"`);
    }

    for (const { node, matrix, layer } of shapes) {
      const id = node.attributes.id;
      if (!id) {
        problems.push(
          `${file}: a <${node.name}> in ${layer} has no id (expected ${EXPECTED[layer]})`,
        );
        continue;
      }
      const match = PATTERNS[layer].exec(id);
      if (!match) {
        problems.push(`${file}: ${id} in ${layer} doesn't match ${EXPECTED[layer]}`);
        continue;
      }
      const say = (message: string) => problems.push(`${file}: ${id} ${message}`);
      const key = layer === 'rooms' ? `room:${floorId}:${match[1]}` : id;
      if (seenIds.has(key)) {
        say('is used more than once');
        continue;
      }
      seenIds.add(key);
      const point = (p: Pt): Pt => {
        const out = toMap(apply(matrix, p));
        if (out.some((v) => v < 0 || v > 1)) say(`has a point outside the map (${p.join(', ')})`);
        return out.map((v) => Math.min(1, Math.max(0, v))) as Pt;
      };
      const segment = (): [Pt, Pt] | null => {
        const ends = lineEnds(node);
        if (!ends) {
          say(`must be a <line> or a two-point path, got <${node.name}>`);
          return null;
        }
        return [point(ends[0]), point(ends[1])];
      };
      const centre = (): Pt | null => {
        if (node.name !== 'circle' && node.name !== 'ellipse') {
          say(`must be a <circle>, got <${node.name}>`);
          return null;
        }
        return point([num(node, 'cx'), num(node, 'cy')]);
      };
      const floorOf = (claimed: string) => {
        if (claimed !== floorId) say(`is in ${file} but names floor ${claimed}`);
      };

      switch (layer) {
        case 'rooms': {
          const callout = node.attributes['data-callout']?.trim();
          if (!callout) say('has no data-callout');
          const outline = roomOutline(node, say);
          if (!outline || !callout) break;
          const polygon = simplify(
            outline.map((p) => apply(matrix, p)),
            SIMPLIFY_EPSILON,
          ).map(point);
          map.rooms.push({ id: `room:${floorId}:${match[1]}`, floorId, callout, polygon });
          break;
        }
        case 'walls': {
          floorOf(match[1] as string);
          const kind = WallKind.safeParse(node.attributes['data-kind']);
          if (!node.attributes['data-kind']) say('has no data-kind');
          else if (!kind.success) {
            say(
              `has data-kind="${node.attributes['data-kind']}" (expected ${WallKind.options.join(', ')})`,
            );
          }
          const ends = segment();
          if (ends && kind.success) {
            map.walls.push({ id, floorId, from: ends[0], to: ends[1], kind: kind.data });
          }
          break;
        }
        case 'hatches': {
          floorOf(match[1] as string);
          const at = centre();
          if (at) map.hatches.push({ id, floorId, at });
          break;
        }
        case 'openings': {
          floorOf(match[2] as string);
          const ends = segment();
          if (ends) {
            const kind = match[1] as OpeningKind;
            map.openings.push({ id, floorId, from: ends[0], to: ends[1], kind });
          }
          break;
        }
        case 'sites': {
          const site = match[1] as string;
          const room = node.attributes['data-room']?.trim().replace(/^room:/, '');
          if (!room) say('has no data-room');
          if (!meta.sites[site]) say(`names site ${site}, which meta.json doesn't list`);
          const at = centre();
          if (!at || !room) break;
          const list = objectives.get(site) ?? [];
          list.push({ floorId, label: match[2] as string, at, roomId: `room:${floorId}:${room}` });
          objectives.set(site, list);
          break;
        }
        case 'spawns': {
          const at = centre();
          const name = node.attributes['data-name']?.trim() || titleCase(match[2] as string);
          if (at)
            map.spawns.push({ id, name, side: match[1] as 'attack' | 'defence', floorId, at });
          break;
        }
      }
    }

    if (artLayer) art[floorId] = exportArt(root, artLayer);
  }

  for (const [site, list] of objectives) {
    const floors = new Set(list.map((o) => o.floorId));
    if (floors.size > 1) {
      problems.push(
        `site ${site} has objectives on more than one floor (${[...floors].join(', ')})`,
      );
      continue;
    }
    const name = meta.sites[site]?.name;
    if (!name) continue;
    map.sites.push({
      id: `site:${site}`,
      name,
      floorId: list[0]?.floorId as string,
      objectives: list
        .sort((a, b) => a.label.localeCompare(b.label))
        .map(({ label, at, roomId }) => ({ label, at, roomId })),
    });
  }
  for (const site of Object.keys(meta.sites)) {
    if (!objectives.has(site)) problems.push(`meta.json: site ${site} has no obj:${site}:A or B`);
  }

  if (problems.length > 0) throw new ExtractError(problems);
  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  for (const list of [map.sites, map.rooms, map.walls, map.hatches, map.openings, map.spawns]) {
    list.sort(byId);
  }
  return { map, art };
}

/** Endpoints of a `<line>` or a path that is one straight segment. */
function lineEnds(node: INode): [Pt, Pt] | null {
  if (node.name === 'line') {
    return [
      [num(node, 'x1'), num(node, 'y1')],
      [num(node, 'x2'), num(node, 'y2')],
    ];
  }
  if (node.name === 'path' && node.attributes.d) {
    const subpaths = flattenPath(node.attributes.d);
    const only = subpaths[0];
    if (subpaths.length === 1 && only && !only.closed && only.points.length === 2) {
      return [only.points[0] as Pt, only.points[1] as Pt];
    }
  }
  return null;
}

/** A room's outline in canvas units, or null (after reporting) when it isn't one closed shape. */
function roomOutline(node: INode, say: (message: string) => void): Pt[] | null {
  let points: Pt[];
  switch (node.name) {
    case 'rect': {
      const x = num(node, 'x');
      const y = num(node, 'y');
      const w = num(node, 'width');
      const h = num(node, 'height');
      points = [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ];
      break;
    }
    case 'polygon':
      points = parsePoints(node.attributes.points ?? '');
      break;
    case 'path': {
      let subpaths: ReturnType<typeof flattenPath>;
      try {
        subpaths = flattenPath(node.attributes.d ?? '');
      } catch (err) {
        say(`has a path that doesn't parse (${(err as Error).message})`);
        return null;
      }
      if (subpaths.length !== 1) {
        say(`must be one closed shape, has ${subpaths.length} subpaths`);
        return null;
      }
      const only = subpaths[0] as { points: Pt[]; closed: boolean };
      const first = only.points[0] as Pt;
      const last = only.points.at(-1) as Pt;
      const ends = Math.hypot(last[0] - first[0], last[1] - first[1]);
      if (!only.closed && ends > 0.5) {
        say('is not closed (end its path with Z)');
        return null;
      }
      points = only.points;
      break;
    }
    default:
      say(`must be a closed <path>, <polygon> or <rect>, got <${node.name}>`);
      return null;
  }
  // A closing point that repeats the first one is implied by the polygon.
  const first = points[0];
  const last = points.at(-1);
  if (first && last && points.length > 1 && first[0] === last[0] && first[1] === last[1]) {
    points = points.slice(0, -1);
  }
  if (points.length < 3) {
    say(`has ${points.length} points; a room needs at least 3`);
    return null;
  }
  return points;
}

function parsePoints(value: string): Pt[] {
  const nums = value
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);
  const out: Pt[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) out.push([nums[i] as number, nums[i + 1] as number]);
  return out;
}

/** Editor-only attributes (Inkscape, Sodipodi) that the display SVG doesn't need. */
const EDITOR_PREFIXES = ['inkscape:', 'sodipodi:', 'xmlns:inkscape', 'xmlns:sodipodi'];

function stripEditor(node: INode): INode {
  const attributes: Record<string, string> = {};
  for (const [k, v] of Object.entries(node.attributes)) {
    if (!EDITOR_PREFIXES.some((p) => k.startsWith(p)) && !k.startsWith('data-')) attributes[k] = v;
  }
  return {
    ...node,
    attributes,
    children: node.children
      .filter((c) => c.type !== 'element' || !c.name.includes(':'))
      .map(stripEditor),
  };
}

/** The display SVG: the art layer alone (plus `<defs>`), editor attributes stripped, minified. */
function exportArt(root: INode, artLayer: INode): string {
  const defs = root.children.filter((c) => c.type === 'element' && c.name === 'defs');
  const svg: INode = {
    name: 'svg',
    type: 'element',
    value: '',
    attributes: {
      xmlns: 'http://www.w3.org/2000/svg',
      viewBox: VIEWBOX,
      width: String(CANVAS),
      height: String(CANVAS),
    },
    children: [...defs, { ...artLayer, attributes: { ...artLayer.attributes } }].map(stripEditor),
  };
  return optimize(stringify(svg), {
    multipass: true,
    plugins: [
      {
        name: 'preset-default',
        params: {
          overrides: {
            // Pixi's SVG parser reads presentation attributes; keep them as attributes.
            inlineStyles: false,
            minifyStyles: false,
          },
        },
      },
      'convertStyleToAttrs',
    ],
  }).data;
}
