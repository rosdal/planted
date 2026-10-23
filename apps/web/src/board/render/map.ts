import { Assets, Container, Graphics, type GraphicsContext } from 'pixi.js';
import { WORLD_SIZE } from '../coords';

export const TEST_FLOOR_URL = '/dev/test-floor.svg';
const GRID_STEP = 256;
const LINE_ALPHA = 0.7;
const GRID_ALPHA = 0.07;

/**
 * Grid and floor art, bottom of the world. The floor SVG is drawn in white and tinted with the
 * theme's text colour, so it reads in dark and light mode alike.
 *
 * The SVG is parsed into Graphics geometry rather than rasterised into a texture: vectors stay
 * sharp at 8× zoom, where a 4096 px texture would need 32k pixels a side. Real maps may still
 * move to tiles in 0.5 if their art gets too detailed for geometry.
 */
export class MapLayer {
  readonly container = new Container({ label: 'mapLayer' });
  readonly #grid = new Graphics({ label: 'grid' });
  #floor: Graphics | null = null;

  constructor() {
    // Drawn once, never per frame. `pixelLine` keeps it one device pixel wide at every zoom.
    for (let i = 0; i <= WORLD_SIZE; i += GRID_STEP) {
      this.#grid.moveTo(i, 0).lineTo(i, WORLD_SIZE);
      this.#grid.moveTo(0, i).lineTo(WORLD_SIZE, i);
    }
    this.#grid.stroke({ width: 1, color: 0xffffff, pixelLine: true });
    this.#grid.alpha = GRID_ALPHA;
    this.container.addChild(this.#grid);
  }

  async loadFloor(url = TEST_FLOOR_URL): Promise<void> {
    // Assets caches the parsed context, so a remount (StrictMode, navigation) parses once.
    const context = await Assets.load<GraphicsContext>({
      src: url,
      data: { parseAsGraphicsContext: true },
    });
    if (this.container.destroyed) return;
    const floor = new Graphics({ context, label: 'floor' });
    floor.alpha = LINE_ALPHA;
    floor.tint = this.#grid.tint;
    this.#floor = floor;
    this.container.addChild(floor);
  }

  /** The theme's text colour; grid and floor both take it. */
  setInk(colour: string): void {
    this.#grid.tint = colour;
    if (this.#floor) this.#floor.tint = colour;
  }
}
