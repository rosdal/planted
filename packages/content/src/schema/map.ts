import { z } from 'zod';
import { Side, Slug, Vec2 } from './common';

export const WallKind = z.enum(['soft', 'reinforceable', 'hard', 'outer']);
export type WallKind = z.infer<typeof WallKind>;

export const OpeningKind = z.enum(['door', 'window', 'vault']);
export type OpeningKind = z.infer<typeof OpeningKind>;

export const Floor = z.object({
  id: Slug,
  label: z.string().min(1),
  order: z.number().int(),
  /** `art/<floorId>.svg` in the source tree; the hashed filename after build. */
  art: z.string().min(1),
});
export type Floor = z.infer<typeof Floor>;

export const Objective = z.object({ label: z.string().min(1), at: Vec2, roomId: z.string() });

export const Site = z.object({
  id: z.string(),
  name: z.string().min(1),
  floorId: z.string(),
  objectives: z.array(Objective).min(1),
});
export type Site = z.infer<typeof Site>;

export const Room = z.object({
  /** `room:<floor>:<slug>`: the floor is part of the id so slugs may repeat across floors. */
  id: z.string(),
  floorId: z.string(),
  callout: z.string().min(1),
  polygon: z.array(Vec2).min(3),
});
export type Room = z.infer<typeof Room>;

export const Wall = z.object({
  /** Stable across seasons: `wall:2f:gym-north`. Stamps and wall states point at it (0.6). */
  id: z.string(),
  floorId: z.string(),
  from: Vec2,
  to: Vec2,
  kind: WallKind,
});
export type Wall = z.infer<typeof Wall>;

export const Hatch = z.object({ id: z.string(), floorId: z.string(), at: Vec2 });
export type Hatch = z.infer<typeof Hatch>;

export const Opening = z.object({
  id: z.string(),
  floorId: z.string(),
  from: Vec2,
  to: Vec2,
  kind: OpeningKind,
});
export type Opening = z.infer<typeof Opening>;

export const Spawn = z.object({
  id: z.string(),
  name: z.string().min(1),
  side: Side,
  floorId: z.string(),
  at: Vec2,
});
export type Spawn = z.infer<typeof Spawn>;

/** `maps/<mapId>/map.json`: written by the extractor, never by hand. */
export const MapData = z.object({
  id: Slug,
  name: z.string().min(1),
  /** Season tag of this layout, e.g. `y11s3`. */
  contentRev: z.string(),
  floors: z.array(Floor).min(1),
  sites: z.array(Site),
  rooms: z.array(Room),
  walls: z.array(Wall),
  hatches: z.array(Hatch),
  openings: z.array(Opening),
  spawns: z.array(Spawn),
});
export type MapData = z.infer<typeof MapData>;

/** `maps/<mapId>/meta.json`: the hand-written part of a map, merged in by the extractor. */
export const MapMeta = z.strictObject({
  id: Slug,
  name: z.string().min(1),
  contentRev: z.string(),
  floors: z.array(z.strictObject({ id: Slug, label: z.string().min(1), order: z.number().int() })),
  /** Keyed by the `<site>` part of `obj:<site>:<A or B>`. */
  sites: z.record(Slug, z.strictObject({ name: z.string().min(1) })),
});
export type MapMeta = z.infer<typeof MapMeta>;

/**
 * `maps/<mapId>/migrations/<rev>.json`: wall and hatch ids that were removed (`null`) or renamed
 * since the last release. 0.9 uses these to move stamps; 0.5 only lets the stability check pass.
 */
export const IdMigration = z.record(z.string(), z.string().nullable());
export type IdMigration = z.infer<typeof IdMigration>;
