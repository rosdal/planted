import { BoardObject, ObjectId } from '@planted/schema';
import * as Y from 'yjs';

/** Root types a doc may have. Dev builds add the 0.2 debug list and the bots' latency probe. */
export function allowedRoots(dev: boolean): ReadonlySet<string> {
  return new Set(dev ? ['objects', 'meta', 'debug-items', 'latency'] : ['objects', 'meta']);
}

export type ObjectIssue = { id: string; issues: string[] };

/**
 * Null when `value` (what `objects.get(id)` holds) is a valid board object on one of `floors`,
 * the floors of the room's map.
 */
export function checkObject(
  id: string,
  value: unknown,
  floors: ReadonlySet<string>,
): ObjectIssue | null {
  const issues: string[] = [];
  if (!ObjectId.safeParse(id).success) issues.push('id: not a 12-character base62 id');
  if (!(value instanceof Y.Map)) {
    issues.push('not a nested Y.Map');
  } else {
    const parsed = BoardObject.safeParse(Object.fromEntries(value.entries()));
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        issues.push(`${issue.path.join('.') || '(root)'}: ${issue.message}`);
      }
    } else if (!floors.has(parsed.data.floor)) {
      issues.push(`floor: ${parsed.data.floor} is not a floor of this map`);
    }
  }
  return issues.length > 0 ? { id, issues } : null;
}

/**
 * Collects the ids of objects changed by transactions whose origin passes `track`, from
 * `objects.observeDeep`, which fires at the end of each transaction. `added` holds the keys that
 * didn't exist before; `touched` holds every key added, changed, or with a changed field.
 */
export class ObjectTracker {
  touched = new Set<string>();
  added = new Set<string>();

  constructor(
    private readonly objects: Y.Map<unknown>,
    private readonly track: (origin: unknown) => boolean,
  ) {
    objects.observeDeep(this.#observe);
  }

  /** Returns what was collected since the last call, and starts over. */
  take(): { touched: Set<string>; added: Set<string> } {
    const out = { touched: this.touched, added: this.added };
    this.touched = new Set();
    this.added = new Set();
    return out;
  }

  destroy(): void {
    this.objects.unobserveDeep(this.#observe);
  }

  #observe = (events: Y.YEvent<Y.AbstractType<unknown>>[], transaction: Y.Transaction): void => {
    if (!this.track(transaction.origin)) return;
    for (const event of events) {
      if (event.target === this.objects) {
        for (const [key, change] of event.changes.keys) {
          this.touched.add(key);
          if (change.action === 'add') this.added.add(key);
        }
      } else {
        const id = event.path[0];
        if (typeof id === 'string') this.touched.add(id);
      }
    }
  };
}
