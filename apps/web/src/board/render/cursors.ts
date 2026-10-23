import { BitmapFont, BitmapText, Container, Graphics } from 'pixi.js';
import type { Awareness } from 'y-protocols/awareness';
import { type Camera, mapToScreen, type Point, WORLD_SIZE } from '../coords';

export const TAG_FONT = 'planted-tag';
const TAG_SIZE = 12;
/** Easing per 60 Hz frame; scaled by the real frame time so it feels the same at 120 Hz. */
const EASE = 0.35;
/** A jump bigger than this share of the screen is a teleport, not a glide. */
const SNAP_SHARE = 0.25;
const IDLE_MS = 10_000;
const FADE_MS = 300;
const TEXT_COLOUR = 0x0a0a0a;

/**
 * Bake Geist into a bitmap font once at startup. A normal `Text` re-rasterises on every change,
 * which gets slow with 10 cursors; `BitmapText` only lays out quads. Waits for the web font so
 * the atlas isn't baked from the fallback face.
 */
export async function installTagFont(): Promise<void> {
  try {
    await document.fonts.load(`500 ${TAG_SIZE}px "Geist Variable"`);
  } catch {
    // Falls back to the system sans in the atlas; still readable.
  }
  BitmapFont.install({
    name: TAG_FONT,
    style: {
      fontFamily: '"Geist Variable", ui-sans-serif, system-ui, sans-serif',
      fontSize: TAG_SIZE,
      fontWeight: '500',
      fill: 0xffffff,
    },
    chars: [
      [' ', '~'],
      [' ', 'ſ'],
    ],
    resolution: Math.max(2, Math.ceil(window.devicePixelRatio || 1)),
    padding: 2,
  });
}

type Cursor = {
  container: Container;
  arrow: Graphics;
  pill: Graphics;
  label: BitmapText;
  name: string;
  colour: string;
  target: Point | null;
  pos: Point | null;
  lastMoveAt: number;
};

function parsePoint(value: unknown): Point | null {
  if (typeof value !== 'object' || value === null) return null;
  const { x, y } = value as Record<string, unknown>;
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function parseUser(value: unknown): { name: string; colour: string } {
  const { name, colour } = (typeof value === 'object' && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  return {
    name: typeof name === 'string' ? name.slice(0, 40) : 'Guest',
    colour: typeof colour === 'string' && /^#[0-9a-f]{6}$/i.test(colour) ? colour : '#a1a1a1',
  };
}

/**
 * Remote cursors in screen space (outside the world container, so name tags never scale). The
 * map-space position eases toward the latest awareness value and is projected through the
 * camera every frame, so cursors stay glued to the map through pan and zoom.
 */
export class CursorLayer {
  readonly container = new Container({ label: 'cursorLayer' });
  readonly #cursors = new Map<number, Cursor>();
  readonly #dirty = new Set<number>();
  readonly #awareness: Awareness;
  constructor(awareness: Awareness) {
    this.#awareness = awareness;
    awareness.on('change', this.#onChange);
    for (const clientId of awareness.getStates().keys()) this.#dirty.add(clientId);
  }

  /** Cursors currently on screen. */
  get visibleCount(): number {
    let n = 0;
    for (const cursor of this.#cursors.values()) if (cursor.container.visible) n++;
    return n;
  }

  render(now: number, dtMs: number, camera: Camera, viewport: { width: number; height: number }) {
    for (const clientId of this.#dirty) this.#apply(clientId, now);
    this.#dirty.clear();

    const ease = 1 - (1 - EASE) ** Math.min(4, dtMs / (1000 / 60));
    const snapPx = SNAP_SHARE * Math.max(viewport.width, viewport.height);
    const pxPerMap = WORLD_SIZE * camera.scale;
    for (const cursor of this.#cursors.values()) {
      const { target } = cursor;
      if (!target) {
        cursor.container.visible = false;
        continue;
      }
      let pos = cursor.pos;
      if (!pos || Math.hypot(target.x - pos.x, target.y - pos.y) * pxPerMap > snapPx) {
        pos = { ...target };
      } else {
        pos = { x: pos.x + (target.x - pos.x) * ease, y: pos.y + (target.y - pos.y) * ease };
      }
      cursor.pos = pos;
      const screen = mapToScreen(camera, pos);
      cursor.container.position.set(screen.x, screen.y);
      const idle = now - cursor.lastMoveAt > IDLE_MS;
      const alpha = idle ? Math.max(0, cursor.container.alpha - dtMs / FADE_MS) : 1;
      cursor.container.alpha = alpha;
      cursor.container.visible = alpha > 0;
    }
  }

  destroy(): void {
    this.#awareness.off('change', this.#onChange);
    this.container.destroy({ children: true });
    this.#cursors.clear();
  }

  #apply(clientId: number, now: number): void {
    if (clientId === this.#awareness.clientID) return;
    const state = this.#awareness.getStates().get(clientId);
    const existing = this.#cursors.get(clientId);
    if (!state) {
      // Their awareness state is gone (tab closed, socket dropped): remove at once.
      if (existing) {
        existing.container.destroy({ children: true });
        this.#cursors.delete(clientId);
      }
      return;
    }
    const user = parseUser(state.user);
    const cursor = existing ?? this.#create(clientId, user);
    if (cursor.name !== user.name || cursor.colour !== user.colour) this.#style(cursor, user);
    const target = parsePoint(state.cursor);
    if (!target) {
      cursor.target = null;
      cursor.pos = null;
      return;
    }
    if (!cursor.target || cursor.target.x !== target.x || cursor.target.y !== target.y) {
      cursor.target = target;
      cursor.lastMoveAt = now;
      cursor.container.alpha = 1;
    }
  }

  #create(clientId: number, user: { name: string; colour: string }): Cursor {
    const container = new Container({ label: `cursor-${clientId}` });
    const arrow = new Graphics();
    const pill = new Graphics();
    const label = new BitmapText({ text: '', style: { fontFamily: TAG_FONT, fontSize: TAG_SIZE } });
    label.tint = TEXT_COLOUR;
    container.addChild(arrow, pill, label);
    container.visible = false;
    this.container.addChild(container);
    const cursor: Cursor = {
      container,
      arrow,
      pill,
      label,
      name: '',
      colour: '',
      target: null,
      pos: null,
      lastMoveAt: 0,
    };
    this.#cursors.set(clientId, cursor);
    this.#style(cursor, user);
    return cursor;
  }

  #style(cursor: Cursor, user: { name: string; colour: string }): void {
    cursor.name = user.name;
    cursor.colour = user.colour;
    // Arrow tip at (0, 0), which is the pointer position.
    cursor.arrow
      .clear()
      .poly([0, 0, 0, 16, 4.5, 12, 7.5, 18.5, 10, 17.5, 7, 11, 12, 11])
      .fill(user.colour)
      .stroke({ width: 1.25, color: 0xffffff, join: 'round' });
    cursor.label.text = user.name;
    const padX = 6;
    const height = 18;
    const left = 12;
    const top = 18;
    cursor.pill
      .clear()
      .roundRect(left, top, cursor.label.width + padX * 2, height, 6)
      .fill(user.colour);
    cursor.label.position.set(left + padX, top + (height - cursor.label.height) / 2);
  }

  #onChange = ({
    added,
    updated,
    removed,
  }: {
    added: number[];
    updated: number[];
    removed: number[];
  }): void => {
    for (const id of added) this.#dirty.add(id);
    for (const id of updated) this.#dirty.add(id);
    for (const id of removed) this.#dirty.add(id);
  };
}
