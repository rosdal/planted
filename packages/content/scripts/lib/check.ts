import type { z } from 'zod';
import {
  Gadgets,
  type IdMigration,
  MapData,
  Operators,
  Rules,
  WeaponClasses,
} from '../../src/schema';
import { type Pt, selfIntersection } from './geometry';

/** Schema, unique ids, room polygons, floor references and objective rooms of one map. */
export function checkMap(input: unknown): { map: MapData | null; problems: string[] } {
  const parsed = MapData.safeParse(input);
  if (!parsed.success) {
    return {
      map: null,
      problems: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    };
  }
  const map = parsed.data;
  const problems: string[] = [];
  const floors = new Set(map.floors.map((f) => f.id));
  if (floors.size !== map.floors.length) problems.push('two floors share an id');

  const seen = new Set<string>();
  const things = [
    ...map.sites,
    ...map.rooms,
    ...map.walls,
    ...map.hatches,
    ...map.openings,
    ...map.spawns,
  ];
  for (const thing of things) {
    if (seen.has(thing.id)) problems.push(`${thing.id} is used more than once`);
    seen.add(thing.id);
    if (!floors.has(thing.floorId))
      problems.push(`${thing.id} is on unknown floor ${thing.floorId}`);
  }

  for (const room of map.rooms) {
    const crossing = selfIntersection(room.polygon as Pt[]);
    if (crossing) {
      problems.push(`${room.id} outline crosses itself (edges ${crossing[0]} and ${crossing[1]})`);
    }
  }
  for (const wall of map.walls) {
    for (const v of [...wall.from, ...wall.to]) {
      if (v < 0 || v > 1) problems.push(`${wall.id} has an endpoint outside 0..1`);
    }
  }
  const rooms = new Map(map.rooms.map((r) => [r.id, r]));
  for (const site of map.sites) {
    for (const objective of site.objectives) {
      const room = rooms.get(objective.roomId);
      if (!room)
        problems.push(`${site.id} ${objective.label}: room ${objective.roomId} doesn't exist`);
      else if (room.floorId !== site.floorId) {
        problems.push(
          `${site.id} ${objective.label}: room ${objective.roomId} is on another floor`,
        );
      }
    }
  }
  return { map, problems };
}

/**
 * Wall and hatch ids are what stamps and wall states point at, so they must survive a new
 * season. Every id in the baseline that is gone now fails unless a migration maps it, either to
 * `null` (removed on purpose) or to an id that exists now.
 */
export function checkStability(
  current: MapData,
  baseline: MapData,
  migrations: IdMigration,
): string[] {
  const problems: string[] = [];
  const now = new Set([...current.walls, ...current.hatches].map((x) => x.id));
  for (const { id } of [...baseline.walls, ...baseline.hatches]) {
    if (now.has(id)) continue;
    if (!(id in migrations)) {
      problems.push(
        `${id} was in the last release and is gone; add it to migrations/<rev>.json as ` +
          `{ "${id}": null } or { "${id}": "<new id>" }`,
      );
      continue;
    }
    const to = migrations[id];
    if (to && !now.has(to)) problems.push(`migration maps ${id} to ${to}, which doesn't exist`);
  }
  return problems;
}

export type Catalogues = {
  operators: unknown;
  gadgets: unknown;
  weaponClasses: unknown;
  rules: unknown;
};

/**
 * Each catalogue against its schema, then the references between them: every gadget id an
 * operator names exists and is on the right side, every icon id has a source SVG, ids are
 * unique, and badges don't collide on the same side.
 */
export function checkCatalogues(input: Catalogues, iconIds: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const parse = <T>(name: string, schema: z.ZodType<T>, value: unknown): T | null => {
    const result = schema.safeParse(value);
    if (result.success) return result.data;
    for (const i of result.error.issues)
      problems.push(`${name}: ${i.path.join('.')}: ${i.message}`);
    return null;
  };
  const operators = parse('operators.json', Operators, input.operators);
  const gadgets = parse('gadgets.json', Gadgets, input.gadgets);
  const weapons = parse('weapon-classes.json', WeaponClasses, input.weaponClasses);
  parse('rules.json', Rules, input.rules);
  if (!operators || !gadgets || !weapons) return problems;

  const unique = (name: string, ids: string[]) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) problems.push(`${name}: ${id} is listed twice`);
      seen.add(id);
    }
  };
  unique(
    'operators.json',
    operators.map((o) => o.id),
  );
  unique(
    'gadgets.json',
    gadgets.map((g) => g.id),
  );
  unique(
    'weapon-classes.json',
    weapons.map((w) => w.id),
  );

  const byId = new Map(gadgets.map((g) => [g.id, g]));
  const badges = new Map<string, string>();
  for (const op of operators) {
    const key = `${op.side}:${op.badge}`;
    const other = badges.get(key);
    if (other) problems.push(`operators.json: ${op.id} and ${other} share badge ${op.badge}`);
    badges.set(key, op.id);

    const own = byId.get(op.uniqueGadget.gadgetId);
    if (!own)
      problems.push(
        `operators.json: ${op.id} unique gadget ${op.uniqueGadget.gadgetId} doesn't exist`,
      );
    else if (!own.unique)
      problems.push(`operators.json: ${op.id} unique gadget ${own.id} isn't marked unique`);
    for (const id of op.secondaryGadgetOptions) {
      const gadget = byId.get(id);
      if (!gadget) problems.push(`operators.json: ${op.id} secondary ${id} doesn't exist`);
      else if (gadget.unique)
        problems.push(`operators.json: ${op.id} secondary ${id} is a unique gadget`);
      else if (gadget.side !== 'both' && gadget.side !== op.side) {
        problems.push(`operators.json: ${op.id} (${op.side}) can't take ${id} (${gadget.side})`);
      }
    }
  }
  for (const g of gadgets) {
    if (!iconIds.has(g.iconId))
      problems.push(`gadgets.json: ${g.id} icon ${g.iconId} has no icons/src/${g.iconId}.svg`);
  }
  for (const w of weapons) {
    if (!iconIds.has(w.iconId))
      problems.push(
        `weapon-classes.json: ${w.id} icon ${w.iconId} has no icons/src/${w.iconId}.svg`,
      );
  }
  return problems;
}
