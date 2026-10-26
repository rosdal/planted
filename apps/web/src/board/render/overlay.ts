import type { MapData, Vec2, WallKind } from '@planted/content';
import { BitmapText, Container, Graphics } from 'pixi.js';
import { type Camera, mapToScreen, type Point, WORLD_SIZE } from '../coords';
import { TAG_FONT } from './cursors';

const CALLOUT_SIZE = 12;
const PILL_PAD_X = 6;
const PILL_HEIGHT = 18;
/** A callout shows only when its room is at least this much wider on screen than the label. */
const CALLOUT_ROOM_MARGIN_PX = 12;
const PILL_FILL = 0x0a0a0a;
const PILL_ALPHA = 0.72;
const TEXT_COLOUR = 0xffffff;
/** The hover callout sits this far below and right of the pointer, clear of the cursor arrow. */
const HOVER_OFFSET = { x: 14, y: 18 };

/**
 * Wall styling by kind, in world units. Reinforceable walls are what a plan is about, so they
 * stand out; hard walls are darker and thicker; soft walls are a faint line. Outer walls are
 * already drawn bold by the floor art.
 */
const WALL_STYLE: Record<WallKind, { width: number; color: number; alpha: number } | null> = {
  reinforceable: { width: 14, color: 0xe3b341, alpha: 0.95 },
  hard: { width: 18, color: 0x6e7681, alpha: 0.95 },
  soft: { width: 6, color: 0xffffff, alpha: 0.35 },
  outer: null,
};
const HATCH = { size: 72, width: 8, color: 0xe3b341 };
const OPENING_STYLE = {
  door: { width: 8, color: 0x8ddb8c },
  window: { width: 8, color: 0x6cb6ff },
  vault: { width: 8, color: 0xdcbdfb },
} as const;

const world = ([x, y]: Vec2): [number, number] => [x * WORLD_SIZE, y * WORLD_SIZE];

function centroid(polygon: readonly Vec2[]): Point {
  // Area-weighted centroid; falls back to the vertex average for a degenerate outline.
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [x0, y0] = polygon[i] as Vec2;
    const [x1, y1] = polygon[(i + 1) % polygon.length] as Vec2;
    const cross = x0 * y1 - x1 * y0;
    area += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  if (Math.abs(area) < 1e-12) {
    const n = polygon.length || 1;
    return {
      x: polygon.reduce((s, p) => s + p[0], 0) / n,
      y: polygon.reduce((s, p) => s + p[1], 0) / n,
    };
  }
  return { x: cx / (3 * area), y: cy / (3 * area) };
}

/** Ray-casting point-in-polygon, in map space. */
export function pointInPolygon({ x, y }: Point, polygon: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i] as Vec2;
    const [xj, yj] = polygon[j] as Vec2;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The callout of the room under `p` on `floorId`, or null. */
export function calloutAt(map: MapData, floorId: string, p: Point): string | null {
  for (const room of map.rooms) {
    if (room.floorId === floorId && pointInPolygon(p, room.polygon)) return room.callout;
  }
  return null;
}

type Label = { container: Container; pill: Graphics; text: BitmapText };

function makeLabel(text: string): Label {
  const container = new Container();
  const pill = new Graphics();
  const label = new BitmapText({ text, style: { fontFamily: TAG_FONT, fontSize: CALLOUT_SIZE } });
  label.tint = TEXT_COLOUR;
  container.addChild(pill, label);
  const result = { container, pill, text: label };
  setLabelText(result, text);
  return result;
}

function setLabelText(label: Label, text: string): void {
  label.text.text = text;
  const width = label.text.width + PILL_PAD_X * 2;
  label.pill
    .clear()
    .roundRect(-width / 2, -PILL_HEIGHT / 2, width, PILL_HEIGHT, 6)
    .fill({ color: PILL_FILL, alpha: PILL_ALPHA });
  label.text.position.set(-label.text.width / 2, -label.text.height / 2);
}

/**
 * The map data overlay, toggled with `L`. Walls, hatches and openings are drawn once per floor
 * in world space (`world`); room callouts are screen-space labels (`screen`), placed every frame
 * so their text never scales, and hidden while their room is too small on screen to fit them.
 */
export class MapOverlay {
  readonly world = new Container({ label: 'overlayWorld' });
  readonly screen = new Container({ label: 'overlayScreen' });
  readonly #map: MapData;
  readonly #floors = new Map<string, Graphics>();
  #callouts: { label: Label; at: Point; roomWidth: number }[] = [];
  #visible = true;

  constructor(map: MapData) {
    this.#map = map;
  }

  get visible(): boolean {
    return this.#visible;
  }

  setVisible(visible: boolean): void {
    this.#visible = visible;
    this.world.visible = visible;
    this.screen.visible = visible;
  }

  setFloor(floorId: string): void {
    let g = this.#floors.get(floorId);
    if (!g) {
      g = this.#draw(floorId);
      this.#floors.set(floorId, g);
      this.world.addChild(g);
    }
    for (const [id, graphics] of this.#floors) graphics.visible = id === floorId;
    for (const { label } of this.#callouts) label.container.destroy({ children: true });
    this.#callouts = this.#map.rooms
      .filter((r) => r.floorId === floorId)
      .map((room) => {
        const label = makeLabel(room.callout);
        this.screen.addChild(label.container);
        const xs = room.polygon.map((p) => p[0]);
        return { label, at: centroid(room.polygon), roomWidth: Math.max(...xs) - Math.min(...xs) };
      });
  }

  /** Once a frame while visible: place callouts for this camera. */
  render(camera: Camera): void {
    if (!this.#visible) return;
    const pxPerMap = WORLD_SIZE * camera.scale;
    for (const { label, at, roomWidth } of this.#callouts) {
      const fits = roomWidth * pxPerMap >= label.pill.width + CALLOUT_ROOM_MARGIN_PX;
      label.container.visible = fits;
      if (!fits) continue;
      const s = mapToScreen(camera, at);
      label.container.position.set(Math.round(s.x), Math.round(s.y));
    }
  }

  /** Callouts currently drawn, for tests and the dev overlay. */
  get visibleCallouts(): string[] {
    if (!this.#visible) return [];
    return this.#callouts.filter((c) => c.label.container.visible).map((c) => c.label.text.text);
  }

  destroy(): void {
    this.world.destroy({ children: true });
    this.screen.destroy({ children: true });
  }

  #draw(floorId: string): Graphics {
    const g = new Graphics({ label: `overlay-${floorId}` });
    const on = <T extends { floorId: string }>(list: readonly T[]) =>
      list.filter((x) => x.floorId === floorId);
    for (const wall of on(this.#map.walls)) {
      const style = WALL_STYLE[wall.kind];
      if (!style) continue;
      g.moveTo(...world(wall.from))
        .lineTo(...world(wall.to))
        .stroke({ ...style, cap: 'butt' });
    }
    for (const opening of on(this.#map.openings)) {
      const style = OPENING_STYLE[opening.kind];
      g.moveTo(...world(opening.from))
        .lineTo(...world(opening.to))
        .stroke({ ...style, cap: 'round' });
    }
    for (const hatch of on(this.#map.hatches)) {
      const [x, y] = world(hatch.at);
      const half = HATCH.size / 2;
      g.rect(x - half, y - half, HATCH.size, HATCH.size)
        .stroke({ width: HATCH.width, color: HATCH.color })
        .moveTo(x - half, y - half)
        .lineTo(x + half, y + half)
        .moveTo(x + half, y - half)
        .lineTo(x - half, y + half)
        .stroke({ width: HATCH.width / 2, color: HATCH.color });
    }
    return g;
  }
}

/** The callout of the room under the pointer, shown near it whether or not the overlay is on. */
export class HoverCallout {
  readonly container = new Container({ label: 'hoverCallout' });
  readonly #label = makeLabel('');
  #text: string | null = null;

  constructor() {
    this.container.addChild(this.#label.container);
    this.container.visible = false;
  }

  get text(): string | null {
    return this.#text;
  }

  /** `screen` is the pointer in canvas px; null hides it. */
  set(text: string | null, screen: Point | null): void {
    if (!text || !screen) {
      this.#text = null;
      this.container.visible = false;
      return;
    }
    if (text !== this.#text) setLabelText(this.#label, text);
    this.#text = text;
    const half = this.#label.pill.width / 2;
    this.#label.container.position.set(
      Math.round(screen.x + HOVER_OFFSET.x + half),
      Math.round(screen.y + HOVER_OFFSET.y + PILL_HEIGHT / 2),
    );
    this.container.visible = true;
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}
