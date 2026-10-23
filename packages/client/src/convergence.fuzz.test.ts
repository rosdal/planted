import {
  Channel,
  decodeFrame,
  sync1Frame,
  sync2Frame,
  updateFrame,
  YjsType,
} from '@planted/protocol';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { docHash } from './doc-hash';

/**
 * Convergence fuzzing without sockets. The topology matches production: every peer talks only
 * to a hub doc (the server's), which applies and fans updates out. Frames go through the real
 * codec and sit in one shared queue that delivers in random order and sometimes twice.
 *
 * `FUZZ_RUNS=10000 pnpm test` for a long local run. When a run fails, fast-check prints
 * `{ seed, path }`: add it to `regressions` below, with `chaos` set to match the failing test, so it runs on every CI build.
 */
const RUNS = Number(process.env.FUZZ_RUNS ?? 200);
const regressions: { seed: number; path: string; chaos: boolean }[] = [];

const HUB = -1;
type Message = { from: number; to: number; bytes: Uint8Array };

class FakeNet {
  readonly hub = new Y.Doc();
  readonly peers: Y.Doc[];
  readonly online: boolean[];
  readonly queue: Message[] = [];

  constructor(count: number) {
    this.peers = Array.from({ length: count }, () => new Y.Doc());
    this.online = this.peers.map(() => true);
    this.peers.forEach((doc, i) => {
      doc.on('update', (update: Uint8Array, origin: unknown) => {
        if (origin !== this && this.online[i]) this.#post(i, HUB, updateFrame(update));
      });
    });
    // Like the server: fan out to everyone but the origin.
    this.hub.on('update', (update: Uint8Array, origin: unknown) => {
      this.peers.forEach((_, i) => {
        if (i !== origin && this.online[i]) this.#post(HUB, i, updateFrame(update));
      });
    });
  }

  disconnect(i: number): void {
    this.online[i] = false;
    // A closed socket loses whatever was in flight, in both directions.
    for (let k = this.queue.length - 1; k >= 0; k--) {
      const m = this.queue[k];
      if (m && (m.from === i || m.to === i)) this.queue.splice(k, 1);
    }
  }

  /** Both handshake directions, as on a real reconnect. */
  connect(i: number): void {
    this.online[i] = true;
    const peer = this.peers[i];
    if (!peer) return;
    this.#post(i, HUB, sync1Frame(peer));
    this.#post(HUB, i, sync1Frame(this.hub));
  }

  /** Deliver the message at `index`; with `duplicate`, leave a copy queued too. */
  deliver(index: number, duplicate: boolean): void {
    const m = duplicate ? this.queue[index] : this.queue.splice(index, 1)[0];
    if (!m) return;
    const doc = m.to === HUB ? this.hub : this.peers[m.to];
    if (!doc) return;
    const frame = decodeFrame(m.bytes);
    if (frame.channel !== Channel.Yjs) return;
    if (frame.type === YjsType.Sync1) {
      this.#post(m.to, m.from, sync2Frame(doc, frame.payload));
    } else {
      // At the hub the origin is the sender's index, so it isn't echoed back; at a peer it is
      // the net, so the peer doesn't send it on again.
      Y.applyUpdate(doc, frame.payload, m.to === HUB ? m.from : this);
    }
  }

  drain(): void {
    while (this.queue.length > 0) this.deliver(0, false);
  }

  #post(from: number, to: number, bytes: Uint8Array): void {
    this.queue.push({ from, to, bytes });
  }
}

type Op = { kind: number; peer: number; a: number; b: number };

const op: fc.Arbitrary<Op> = fc.record({
  kind: fc.nat(99),
  peer: fc.nat(7),
  a: fc.nat(1000),
  b: fc.nat(1000),
});

function edit(doc: Y.Doc, { kind, a, b }: Op): void {
  const left = doc.getArray<string>('left');
  const right = doc.getArray<string>('right');
  const map = doc.getMap<number>('map');
  const value = `${doc.clientID}:${a}`;
  switch (kind % 5) {
    case 0:
      left.insert(a % (left.length + 1), [value]);
      break;
    case 1:
      right.insert(a % (right.length + 1), [value, `${value}+`]);
      break;
    case 2:
      if (left.length > 0) {
        const index = a % left.length;
        left.delete(index, Math.min(left.length - index, 1 + (b % 3)));
      }
      break;
    case 3: {
      // A move is a delete plus an insert in one transaction, so it is one update.
      const [from, to] = b % 2 === 0 ? [left, right] : [right, left];
      if (from.length === 0) break;
      const index = a % from.length;
      const item = from.get(index);
      doc.transact(() => {
        from.delete(index, 1);
        to.insert(b % (to.length + 1), [item]);
      });
      break;
    }
    default:
      map.set(`k${a % 8}`, b);
  }
}

function assertConverged(net: FakeNet): void {
  for (let i = 0; i < net.peers.length; i++) net.connect(i);
  net.drain();
  const expected = { hash: docHash(net.hub), json: net.hub.toJSON() };
  for (const peer of net.peers) {
    for (const name of ['left', 'right']) peer.getArray(name);
    peer.getMap('map');
    expect({ hash: docHash(peer), json: peer.toJSON() }).toEqual(expected);
  }
}

/**
 * Each step either edits on a peer or delivers a queued message. With `chaos`, peers also drop
 * off for a while (no frames in or out) and keep editing, then resync via sync-1 / sync-2.
 */
function run(peerCount: number, ops: Op[], chaos: boolean): void {
  const net = new FakeNet(peerCount);
  for (const name of ['left', 'right']) net.hub.getArray(name);
  net.hub.getMap('map');
  for (const o of ops) {
    const peer = o.peer % peerCount;
    const roll = o.kind;
    if (roll < 45) {
      const doc = net.peers[peer];
      if (doc) edit(doc, o);
    } else if (roll < 90 || !chaos) {
      if (net.queue.length > 0) net.deliver(o.a % net.queue.length, o.b % 10 === 0);
    } else if (net.online[peer]) {
      net.disconnect(peer);
    } else {
      net.connect(peer);
    }
  }
  assertConverged(net);
}

const scenario = fc.tuple(
  fc.integer({ min: 2, max: 8 }),
  fc.array(op, { minLength: 50, maxLength: 500 }),
);

describe('convergence', () => {
  it('peers converge under delay, reordering and duplication', { timeout: 600_000 }, () => {
    fc.assert(
      fc.property(scenario, ([peers, ops]) => run(peers, ops, false)),
      { numRuns: RUNS },
    );
  });

  it('peers converge after random disconnects and resyncs', { timeout: 600_000 }, () => {
    fc.assert(
      fc.property(scenario, ([peers, ops]) => run(peers, ops, true)),
      { numRuns: RUNS },
    );
  });

  it.each(regressions)('regression seed $seed', { timeout: 600_000 }, ({ seed, path, chaos }) => {
    fc.assert(
      fc.property(scenario, ([peers, ops]) => run(peers, ops, chaos)),
      { seed, path, endOnFailure: true },
    );
  });
});
