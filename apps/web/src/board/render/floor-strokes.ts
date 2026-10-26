import type { StrokeObject } from '@planted/schema';
import { Container } from 'pixi.js';
import type { SceneSink } from '../scene-store';
import { StrokeLayer } from './stroke';

/**
 * Committed strokes split by floor: one `StrokeLayer` per floor id, and only the current
 * floor's is visible. Switching floors flips visibility; nothing is rebuilt.
 */
export class FloorStrokes implements SceneSink {
  readonly container = new Container({ label: 'floorStrokes' });
  readonly #layers = new Map<string, StrokeLayer>();
  /** Floor of each placed stroke, so an update that moves floors can move the stroke. */
  readonly #floorOf = new Map<string, string>();
  #current: string;

  constructor(current: string) {
    this.#current = current;
  }

  get size(): number {
    return this.#floorOf.size;
  }

  /** Strokes in the layers that are visible right now, whatever floor they belong to. */
  get visibleCount(): number {
    let n = 0;
    for (const layer of this.#layers.values()) if (layer.container.visible) n += layer.size;
    return n;
  }

  show(floorId: string): void {
    this.#current = floorId;
    for (const [id, layer] of this.#layers) layer.container.visible = id === floorId;
  }

  create(id: string, object: StrokeObject): void {
    this.#layer(object.floor).create(id, object);
    this.#floorOf.set(id, object.floor);
  }

  update(id: string, object: StrokeObject): void {
    const before = this.#floorOf.get(id);
    if (before !== undefined && before !== object.floor) this.remove(id);
    if (!this.#floorOf.has(id)) {
      this.create(id, object);
      return;
    }
    this.#layer(object.floor).update(id, object);
  }

  remove(id: string): void {
    const floor = this.#floorOf.get(id);
    if (floor === undefined) return;
    this.#floorOf.delete(id);
    this.#layers.get(floor)?.remove(id);
  }

  #layer(floorId: string): StrokeLayer {
    let layer = this.#layers.get(floorId);
    if (!layer) {
      layer = new StrokeLayer();
      layer.container.label = `strokes-${floorId}`;
      layer.container.visible = floorId === this.#current;
      this.#layers.set(floorId, layer);
      this.container.addChild(layer.container);
    }
    return layer;
  }
}
