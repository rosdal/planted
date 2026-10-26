import { Assets, Container, Graphics, type GraphicsContext } from 'pixi.js';
import { WORLD_SIZE } from '../coords';

const GRID_STEP = 256;
const LINE_ALPHA = 0.7;
const GRID_ALPHA = 0.07;

/**
 * Grid and floor art, bottom of the world. Floor SVGs are drawn in white and tinted with the
 * theme's text colour, so they read in dark and light mode alike.
 *
 * Each SVG is parsed into Graphics geometry rather than rasterised into a texture: vectors stay
 * sharp at 8× zoom, where a 4096 px texture would need 32k pixels a side. One `Graphics` per
 * floor; only the current one is visible. Art loads lazily: the current floor first, the others
 * once it has painted.
 */
export class FloorLayer {
  readonly container = new Container({ label: 'floorLayer' });
  readonly #grid = new Graphics({ label: 'grid' });
  readonly #art: Record<string, string>;
  readonly #floors = new Map<string, Graphics>();
  readonly #loading = new Map<string, Promise<void>>();
  #current: string | null = null;
  #ink: string | number = 0xffffff;

  /** `art` maps floor ids to SVG URLs. */
  constructor(art: Record<string, string>) {
    this.#art = art;
    // Drawn once, never per frame. `pixelLine` keeps it one device pixel wide at every zoom.
    for (let i = 0; i <= WORLD_SIZE; i += GRID_STEP) {
      this.#grid.moveTo(i, 0).lineTo(i, WORLD_SIZE);
      this.#grid.moveTo(0, i).lineTo(WORLD_SIZE, i);
    }
    this.#grid.stroke({ width: 1, color: 0xffffff, pixelLine: true });
    this.#grid.alpha = GRID_ALPHA;
    this.container.addChild(this.#grid);
  }

  /** Shows `floorId`, loading its art first if needed. Resolves once it is drawn. */
  async show(floorId: string): Promise<void> {
    this.#current = floorId;
    for (const [id, g] of this.#floors) g.visible = id === floorId;
    await this.load(floorId);
  }

  /** Loads a floor's art without showing it; for the background preload. */
  load(floorId: string): Promise<void> {
    const existing = this.#loading.get(floorId);
    if (existing) return existing;
    const url = this.#art[floorId];
    if (!url) return Promise.reject(new Error(`no art for floor ${floorId}`));
    const pending = (async () => {
      // Assets caches the parsed context, so a remount (StrictMode, navigation) parses once.
      const context = await Assets.load<GraphicsContext>({
        src: url,
        data: { parseAsGraphicsContext: true },
      });
      if (this.container.destroyed) return;
      const floor = new Graphics({ context, label: `floor-${floorId}` });
      floor.alpha = LINE_ALPHA;
      floor.tint = this.#ink;
      floor.visible = floorId === this.#current;
      this.#floors.set(floorId, floor);
      this.container.addChild(floor);
    })();
    // A failed load may be retried by the next show().
    pending.catch(() => this.#loading.delete(floorId));
    this.#loading.set(floorId, pending);
    return pending;
  }

  /** The theme's text colour; grid and floors all take it. */
  setInk(colour: string): void {
    this.#ink = colour;
    this.#grid.tint = colour;
    for (const g of this.#floors.values()) g.tint = colour;
  }
}
