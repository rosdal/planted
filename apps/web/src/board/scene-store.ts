import { type ObjectsMap, readObject } from '@planted/client';
import { StrokeObject } from '@planted/schema';
import type * as Y from 'yjs';

/** Where the store sends its changes. The Pixi stroke layer in production, a fake in tests. */
export interface SceneSink {
  create(id: string, object: StrokeObject): void;
  update(id: string, object: StrokeObject): void;
  remove(id: string): void;
}

/**
 * Binds the `objects` map to a scene. The Yjs callback only records which top-level ids
 * changed; `flush()`, called once per frame from the Pixi ticker, does the work. So a 100-stroke
 * undo or a whole-doc sync becomes one pass, and nothing renders inside a Yjs transaction.
 */
export class SceneStore {
  readonly #objects: ObjectsMap;
  readonly #sink: SceneSink;
  readonly #dirty = new Set<string>();
  /** Ids the sink currently holds. */
  readonly #live = new Set<string>();
  /** Ids already warned about, so a bad object doesn't spam the console every change. */
  readonly #warned = new Set<string>();

  constructor(objects: ObjectsMap, sink: SceneSink) {
    this.#objects = objects;
    this.#sink = sink;
    // Whatever is already in the doc is built in the first flush, in one pass.
    for (const id of objects.keys()) this.#dirty.add(id);
    objects.observeDeep(this.#onChange);
  }

  /** Objects currently in the scene. */
  get size(): number {
    return this.#live.size;
  }

  get pending(): number {
    return this.#dirty.size;
  }

  has(id: string): boolean {
    return this.#live.has(id);
  }

  /** Apply every change since the last flush. Returns how many ids it touched. */
  flush(): number {
    if (this.#dirty.size === 0) return 0;
    const ids = [...this.#dirty];
    this.#dirty.clear();
    for (const id of ids) this.#apply(id);
    return ids.length;
  }

  destroy(): void {
    this.#objects.unobserveDeep(this.#onChange);
    this.#dirty.clear();
  }

  #apply(id: string): void {
    const map = this.#objects.get(id);
    const parsed = map ? StrokeObject.safeParse(readObject(map)) : null;
    if (parsed?.success) {
      if (this.#live.has(id)) this.#sink.update(id, parsed.data);
      else this.#sink.create(id, parsed.data);
      this.#live.add(id);
      return;
    }
    if (parsed && !this.#warned.has(id)) {
      // Server-side validation arrives in 0.4; until then a bad peer can only hurt itself.
      this.#warned.add(id);
      console.warn(`board: skipping invalid object ${id}`, parsed.error.issues);
    }
    if (this.#live.delete(id)) this.#sink.remove(id);
  }

  #onChange = (events: Y.YEvent<Y.AbstractType<unknown>>[]): void => {
    for (const event of events) {
      if (event.target === this.#objects) {
        for (const key of event.changes.keys.keys()) this.#dirty.add(key);
      } else {
        const id = event.path[0];
        if (typeof id === 'string') this.#dirty.add(id);
      }
    }
  };
}
