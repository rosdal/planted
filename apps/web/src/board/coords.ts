/**
 * The three coordinate spaces of the board. Most canvas bugs are a mix-up between them, so every
 * conversion goes through these functions.
 *
 * | Space  | Range                     | Used for                                |
 * | ------ | ------------------------- | --------------------------------------- |
 * | Map    | 0..1 on both axes, per floor | Everything stored in the Y.Doc       |
 * | World  | 0..WORLD_SIZE units       | Pixi scene graph; the map is this big   |
 * | Screen | CSS pixels of the canvas  | Pointer events, cursors, UI overlays    |
 *
 * World → screen is the camera: `screen = world * scale + (x, y)`, which is exactly what
 * `world.scale` and `world.position` do in Pixi.
 */
export const WORLD_SIZE = 4096;

export type Point = { x: number; y: number };

/** Applied to the world container as `position = (x, y)`, `scale = scale`. */
export type Camera = { x: number; y: number; scale: number };

export function mapToWorld(p: Point): Point {
  return { x: p.x * WORLD_SIZE, y: p.y * WORLD_SIZE };
}

export function worldToMap(p: Point): Point {
  return { x: p.x / WORLD_SIZE, y: p.y / WORLD_SIZE };
}

export function screenToWorld(camera: Camera, p: Point): Point {
  return { x: (p.x - camera.x) / camera.scale, y: (p.y - camera.y) / camera.scale };
}

export function worldToScreen(camera: Camera, p: Point): Point {
  return { x: p.x * camera.scale + camera.x, y: p.y * camera.scale + camera.y };
}

export function screenToMap(camera: Camera, p: Point): Point {
  return worldToMap(screenToWorld(camera, p));
}

export function mapToScreen(camera: Camera, p: Point): Point {
  return worldToScreen(camera, mapToWorld(p));
}

/** One screen pixel in map units at this zoom. */
export function screenPxToMap(camera: Camera, px = 1): number {
  return px / (camera.scale * WORLD_SIZE);
}
