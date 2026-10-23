import { unpackPoints } from '@planted/client';
import type { StrokeObject } from '@planted/schema';
import { Container, Graphics, Rectangle } from 'pixi.js';
import { WORLD_SIZE } from '../coords';
import type { SceneSink } from '../scene-store';

/**
 * Draw flat map-space points into `g` in world units: quadratic curves through the midpoints
 * of successive points, so the line is smooth without storing extra points. One point (a tap)
 * is a filled dot.
 */
export function drawStrokePath(
  g: Graphics,
  points: ArrayLike<number>,
  width: number,
  colour: string,
): void {
  const count = points.length >> 1;
  if (count === 0) return;
  const w = width * WORLD_SIZE;
  const x = (i: number) => (points[i * 2] as number) * WORLD_SIZE;
  const y = (i: number) => (points[i * 2 + 1] as number) * WORLD_SIZE;
  if (count === 1) {
    g.circle(x(0), y(0), w / 2).fill(colour);
    return;
  }
  g.moveTo(x(0), y(0));
  for (let i = 1; i < count - 1; i++) {
    g.quadraticCurveTo(x(i), y(i), (x(i) + x(i + 1)) / 2, (y(i) + y(i + 1)) / 2);
  }
  g.lineTo(x(count - 1), y(count - 1));
  g.stroke({ width: w, color: colour, cap: 'round', join: 'round' });
}

/** Side of a stroke tile in world units: 8 × 8 tiles over the map. */
const TILE_SIZE = 512;
const TILES_PER_SIDE = WORLD_SIZE / TILE_SIZE;

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

type Tile = { container: Container; count: number; bounds: Bounds };

type Placed = { graphics: Graphics; tile: Tile };

/** World-space bounds of a stroke, padded by half its width. */
function strokeBounds(points: Float32Array, width: number): Bounds {
  const pad = (width * WORLD_SIZE) / 2;
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (let i = 0; i < points.length; i += 2) {
    const x = (points[i] as number) * WORLD_SIZE;
    const y = (points[i + 1] as number) * WORLD_SIZE;
    if (x < b.minX) b.minX = x;
    if (x > b.maxX) b.maxX = x;
    if (y < b.minY) b.minY = y;
    if (y > b.maxY) b.maxY = y;
  }
  return { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad };
}

const tileIndex = (v: number) =>
  Math.min(TILES_PER_SIDE - 1, Math.max(0, Math.floor(v / TILE_SIZE)));

/**
 * The committed strokes: one `Graphics` per object, built once and rebuilt only when the object
 * changes, grouped into spatial tiles.
 *
 * Each tile is its own Pixi render group. Pixi re-uploads a render group's whole batch buffer
 * when anything in it changes, and a 30-point stroke is ~600 vertices, so with every stroke in
 * one group each new stroke (and, before `world` was a render group, every pan) re-sent the
 * geometry of all of them: ~36 MB a frame at 2,600 strokes, which pinned the GPU process. Tiles
 * keep a commit to the ~40 strokes near it, and the culler only tests 64 tile bounds instead of
 * every stroke. Strokes in different tiles may draw out of creation order where they overlap;
 * for pen lines that is invisible.
 */
export class StrokeLayer implements SceneSink {
  readonly container = new Container({ label: 'strokeLayer' });
  readonly #placed = new Map<string, Placed>();
  readonly #tiles = new Map<number, Tile>();

  create(id: string, object: StrokeObject): void {
    const points = unpackPoints(object.points);
    const bounds = strokeBounds(points, object.width);
    const tile = this.#tileFor(bounds);
    const graphics = new Graphics({ label: id });
    drawStrokePath(graphics, points, object.width, object.colour);
    tile.container.addChild(graphics);
    tile.count++;
    this.#grow(tile, bounds);
    this.#placed.set(id, { graphics, tile });
  }

  update(id: string, object: StrokeObject): void {
    // Points are immutable after commit, so the stroke stays in its tile.
    const placed = this.#placed.get(id);
    if (!placed) {
      this.create(id, object);
      return;
    }
    placed.graphics.clear();
    drawStrokePath(placed.graphics, unpackPoints(object.points), object.width, object.colour);
  }

  remove(id: string): void {
    const placed = this.#placed.get(id);
    if (!placed) return;
    this.#placed.delete(id);
    placed.graphics.destroy();
    placed.tile.count--;
  }

  get size(): number {
    return this.#placed.size;
  }

  #tileFor(bounds: Bounds): Tile {
    const cx = tileIndex((bounds.minX + bounds.maxX) / 2);
    const cy = tileIndex((bounds.minY + bounds.maxY) / 2);
    const key = cy * TILES_PER_SIDE + cx;
    let tile = this.#tiles.get(key);
    if (!tile) {
      const container = new Container({ label: `tile-${cx}-${cy}`, isRenderGroup: true });
      container.cullable = true;
      tile = {
        container,
        count: 0,
        bounds: { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
      };
      this.#tiles.set(key, tile);
      this.container.addChild(container);
    }
    return tile;
  }

  /** Tile bounds only grow; a removed stroke leaves them a little generous, which is harmless. */
  #grow(tile: Tile, b: Bounds): void {
    const t = tile.bounds;
    t.minX = Math.min(t.minX, b.minX);
    t.minY = Math.min(t.minY, b.minY);
    t.maxX = Math.max(t.maxX, b.maxX);
    t.maxY = Math.max(t.maxY, b.maxY);
    tile.container.cullArea = new Rectangle(t.minX, t.minY, t.maxX - t.minX, t.maxY - t.minY);
  }
}
