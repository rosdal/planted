/**
 * One worker thread's share of `bots.ts`: every bot for the rooms it was given. All bots of a
 * room live in the same worker, so the hash comparison per room needs no cross-thread state.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { parentPort, workerData } from 'node:worker_threads';
import {
  commitStroke,
  createUndoManager,
  docHash,
  newObjectId,
  objectsOf,
  RoomClient,
  type WebSocketCtor,
} from '@planted/client';
import { TEST_FLOOR, USER_COLOURS } from '@planted/schema';
import WebSocket from 'ws';
import * as Y from 'yjs';

export type WorkerConfig = {
  wsUrl: string;
  roomIds: string[];
  botsPerRoom: number;
  opsPerSec: number;
  chaos: { minS: number; maxS: number } | null;
  /** `list` edits the 0.2 debug list; `draw` draws and undoes real strokes on the board. */
  mode: 'list' | 'draw';
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
  strokes: number;
  undos: number;
};
export type WorkerDone = {
  type: 'done';
  rooms: {
    roomId: string;
    hashes: Record<string, number>;
    /** Objects in the room's doc (from its first bot) and the bots' own net strokes. */
    objects: number;
    botStrokes: number;
  }[];
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
  strokes: number;
  undos: number;
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
    strokes: 0,
    undos: 0,
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
  const colour = USER_COLOURS[Math.floor(Math.random() * USER_COLOURS.length)] ?? '#a1a1a1';
  awareness.setLocalStateField('user', { name: bot.name, colour });

  if (config.mode === 'draw') {
    startDrawing(bot, colour);
  } else {
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

const TICK_MS = 1000 / 30;
/** RDP epsilon for commits: 1 screen px at a typical fit zoom (scale 0.25 of a 4096 world). */
const COMMIT_EPSILON = 1 / (0.25 * 4096);
const STROKE_WIDTH = 3 / (0.25 * 4096);
const rand = (min: number, max: number) => min + Math.random() * (max - min);

/** Smooth 1D noise: a few sines with random frequencies and phases, roughly in -1..1. */
function smoothNoise(): (t: number) => number {
  const waves = Array.from({ length: 3 }, () => ({
    f: rand(0.03, 0.15),
    p: rand(0, Math.PI * 2),
  }));
  return (t) => waves.reduce((sum, w) => sum + Math.sin(t * w.f * Math.PI * 2 + w.p), 0) / 3;
}

/**
 * Draw like a person: the cursor wanders at 30 Hz; every 2–6 s it draws a 40–200 point stroke
 * over 1–2 s with live awareness updates, commits it with the shared builder, and 10% of the
 * time undoes it 1 s later.
 */
function startDrawing(bot: Bot, colour: string): void {
  const { doc, awareness } = bot.client;
  const undo = createUndoManager(doc);
  const nx = smoothNoise();
  const ny = smoothNoise();
  const cx = rand(0.25, 0.75);
  const cy = rand(0.25, 0.75);
  let t = rand(0, 1000);
  let stroke: { id: string; points: number[]; target: number; perTick: number } | null = null;
  let nextStrokeAt = Date.now() + rand(2000, 6000);
  let last = { x: cx, y: cy };

  bot.timers.push(
    setInterval(() => {
      t += TICK_MS / 1000;
      // Faster while drawing, so a stroke covers some ground.
      const x = Math.min(0.97, Math.max(0.03, cx + nx(t) * 0.3));
      const y = Math.min(0.97, Math.max(0.03, cy + ny(t) * 0.3));
      const cursor = { x, y };
      if (!stroke) last = cursor;

      if (!stroke && Date.now() >= nextStrokeAt && bot.client.status === 'synced') {
        const target = Math.round(rand(40, 200));
        const ticks = Math.round(rand(1000, 2000) / TICK_MS);
        stroke = { id: newObjectId(), points: [], target, perTick: target / ticks };
      }
      if (!stroke) {
        awareness.setLocalState({ ...awareness.getLocalState(), cursor, live: null });
        return;
      }
      // Several points per tick, spread along the cursor's path since the last tick.
      const have = stroke.points.length / 2;
      const want = Math.min(stroke.target, Math.ceil(have + stroke.perTick));
      for (let i = have; i < want; i++) {
        const k = (i - have + 1) / (want - have);
        stroke.points.push(last.x + (x - last.x) * k, last.y + (y - last.y) * k);
      }
      last = cursor;
      if (stroke.points.length / 2 < stroke.target) {
        const live = {
          id: stroke.id,
          colour,
          width: STROKE_WIDTH,
          points: stroke.points.slice(-2000),
        };
        awareness.setLocalState({ ...awareness.getLocalState(), cursor, live });
        return;
      }
      commitStroke(doc, {
        id: stroke.id,
        floor: TEST_FLOOR,
        colour,
        width: STROKE_WIDTH,
        points: stroke.points,
        epsilon: COMMIT_EPSILON,
        by: bot.name,
      });
      awareness.setLocalState({ ...awareness.getLocalState(), cursor, live: null });
      bot.strokes++;
      stroke = null;
      nextStrokeAt = Date.now() + rand(2000, 6000);
      if (Math.random() < 0.1) {
        const timer = setTimeout(() => {
          if (undo.canUndo()) {
            undo.undo();
            bot.undos++;
          }
        }, 1000);
        bot.timers.push(timer as unknown as ReturnType<typeof setInterval>);
      }
    }, TICK_MS),
  );
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
    strokes: bots.reduce((sum, b) => sum + b.strokes, 0),
    undos: bots.reduce((sum, b) => sum + b.undos, 0),
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
      const roomBots = bots.filter((b) => b.roomId === roomId);
      for (const bot of roomBots) {
        const hash = docHash(bot.client.doc);
        hashes[hash] = (hashes[hash] ?? 0) + 1;
      }
      const first = roomBots[0]?.client.doc;
      return {
        roomId,
        hashes,
        objects: first ? objectsOf(first).size : 0,
        botStrokes: roomBots.reduce((sum, b) => sum + b.strokes - b.undos, 0),
      };
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
