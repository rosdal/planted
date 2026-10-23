/**
 * One worker thread's share of `bots.ts`: every bot for the rooms it was given. All bots of a
 * room live in the same worker, so the hash comparison per room needs no cross-thread state.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { parentPort, workerData } from 'node:worker_threads';
import { docHash, RoomClient, type WebSocketCtor } from '@planted/client';
import WebSocket from 'ws';
import * as Y from 'yjs';

export type WorkerConfig = {
  wsUrl: string;
  roomIds: string[];
  botsPerRoom: number;
  opsPerSec: number;
  chaos: { minS: number; maxS: number } | null;
};

/** Cumulative counters, except `latencies`, which holds only samples since the last report. */
export type WorkerSample = {
  type: 'sample';
  bots: number;
  ops: number;
  frames: number;
  statuses: Record<string, number>;
  latencies: number[];
  loopP99Ms: number;
  items: number;
  docBytes: number;
};
export type WorkerDone = {
  type: 'done';
  rooms: { roomId: string; hashes: Record<string, number> }[];
  /** How long after the load stopped every room in this worker agreed (or the 90 s cap). */
  settleMs: number;
};
export type WorkerError = { type: 'error'; message: string };
export type FromWorker = WorkerSample | WorkerDone | WorkerError;
export type ToWorker = { type: 'report' } | { type: 'finish' };

const MAX_ITEMS = 100;
const config = workerData as WorkerConfig;
const port = parentPort;
if (!port) throw new Error('bot-worker.ts runs as a worker thread of bots.ts');

type Bot = {
  name: string;
  roomId: string;
  client: RoomClient;
  socket: WebSocket | null;
  timers: ReturnType<typeof setInterval>[];
  chaosTimer: ReturnType<typeof setTimeout> | null;
  opsSent: number;
};

const bots: Bot[] = [];
let latencies: number[] = [];
const loopDelay = monitorEventLoopDelay({ resolution: 10 });
loopDelay.enable();

function randomName(): string {
  const words = [
    'Ash',
    'Thermite',
    'Mute',
    'Jager',
    'Bandit',
    'Sledge',
    'Valk',
    'Mira',
    'Thatcher',
  ];
  return `${words[Math.floor(Math.random() * words.length)]}-bot-${Math.floor(Math.random() * 1000)}`;
}

function startBot(roomId: string, isProbe: boolean): Bot {
  const bot: Bot = {
    name: randomName(),
    roomId,
    client: null as unknown as RoomClient,
    socket: null,
    timers: [],
    chaosTimer: null,
    opsSent: 0,
  };
  // Keep a handle on the live socket so --chaos can kill it without a clean close.
  class TrackedWebSocket extends WebSocket {
    constructor(url: string) {
      super(url);
      bot.socket = this;
    }
  }
  const client = new RoomClient({
    url: config.wsUrl,
    roomId,
    WebSocketImpl: TrackedWebSocket as unknown as WebSocketCtor,
  });
  bot.client = client;
  client.on('stop', (reason) => {
    if (reason !== 'destroyed') {
      port?.postMessage({ type: 'error', message: `${bot.name} in ${roomId}: ${reason}` });
    }
  });

  const { doc, awareness } = client;
  awareness.setLocalStateField('user', { name: bot.name, colour: '#a1a1a1' });

  let x = Math.random();
  let y = Math.random();
  bot.timers.push(
    setInterval(() => {
      x = Math.min(1, Math.max(0, x + (Math.random() - 0.5) * 0.02));
      y = Math.min(1, Math.max(0, y + (Math.random() - 0.5) * 0.02));
      awareness.setLocalStateField('cursor', { x, y, floor: 1 });
    }, 1000 / 30),
  );

  const items = doc.getArray<string>('debug-items');
  if (config.opsPerSec > 0) {
    bot.timers.push(
      setInterval(() => {
        if (items.length > 0 && (items.length >= MAX_ITEMS || Math.random() < 0.4)) {
          items.delete(Math.floor(Math.random() * items.length), 1);
        } else {
          items.insert(Math.floor(Math.random() * (items.length + 1)), [
            `${bot.name}:${bot.opsSent}`,
          ]);
        }
        bot.opsSent++;
      }, 1000 / config.opsPerSec),
    );
  }

  const latency = doc.getMap<{ t: number; by: string }>('latency');
  if (isProbe) {
    bot.timers.push(
      setInterval(() => {
        if (client.status === 'synced') latency.set('probe', { t: Date.now(), by: bot.name });
      }, 1000),
    );
  } else {
    // A probe written before we (re)synced arrived via the catch-up sync-2: its age is how
    // long we were away, not relay latency, so it is not counted.
    let syncedAt = Number.POSITIVE_INFINITY;
    client.on('status', (status) => {
      syncedAt = status === 'synced' ? Date.now() : Number.POSITIVE_INFINITY;
    });
    latency.observe((event) => {
      if (event.transaction.local || !event.keysChanged.has('probe')) return;
      const probe = latency.get('probe');
      if (probe && probe.t >= syncedAt) latencies.push(Date.now() - probe.t);
    });
  }

  const { chaos } = config;
  if (chaos) {
    const scheduleDrop = () => {
      bot.chaosTimer = setTimeout(
        () => {
          bot.socket?.terminate();
          scheduleDrop();
        },
        (chaos.minS + Math.random() * (chaos.maxS - chaos.minS)) * 1000,
      );
    };
    scheduleDrop();
  }

  return bot;
}

function sample(): WorkerSample {
  const statuses: Record<string, number> = {};
  for (const bot of bots) statuses[bot.client.status] = (statuses[bot.client.status] ?? 0) + 1;
  const first = bots[0]?.client.doc;
  const out: WorkerSample = {
    type: 'sample',
    bots: bots.length,
    ops: bots.reduce((sum, b) => sum + b.opsSent, 0),
    frames: bots.reduce((sum, b) => sum + b.client.stats.framesReceived, 0),
    statuses,
    latencies,
    loopP99Ms: loopDelay.percentile(99) / 1e6,
    items: first?.getArray('debug-items').length ?? 0,
    docBytes: first ? Y.encodeStateAsUpdate(first).byteLength : 0,
  };
  latencies = [];
  loopDelay.reset();
  return out;
}

/** Stop editing, let in-flight frames land, then hash every doc. */
async function finish(): Promise<WorkerDone> {
  for (const bot of bots) {
    for (const timer of bot.timers) clearInterval(timer);
    if (bot.chaosTimer) clearTimeout(bot.chaosTimer);
    bot.client.wake();
  }
  const hashRooms = () =>
    config.roomIds.map((roomId) => {
      const hashes: Record<string, number> = {};
      for (const bot of bots.filter((b) => b.roomId === roomId)) {
        const hash = docHash(bot.client.doc);
        hashes[hash] = (hashes[hash] ?? 0) + 1;
      }
      return { roomId, hashes };
    });
  // Settled means: every bot synced, and every room's bots agree. A saturated server can take
  // a while to drain after the load stops, so this waits for agreement rather than for quiet.
  const stoppedAt = Date.now();
  const deadline = stoppedAt + 90_000;
  let rooms = hashRooms();
  while (Date.now() < deadline) {
    const synced = bots.every((b) => b.client.status === 'synced');
    if (synced && rooms.every((r) => Object.keys(r.hashes).length === 1)) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
    rooms = hashRooms();
  }
  const settleMs = Date.now() - stoppedAt;
  for (const bot of bots) bot.client.destroy();
  return { type: 'done', rooms, settleMs };
}

for (const roomId of config.roomIds) {
  for (let i = 0; i < config.botsPerRoom; i++) bots.push(startBot(roomId, i === 0));
}

port.on('message', (message: ToWorker) => {
  if (message.type === 'report') port.postMessage(sample());
  else void finish().then((done) => port.postMessage(done));
});
