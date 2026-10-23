/**
 * Headless load: N bots per room, each a real `RoomClient` over the `ws` package.
 *
 *   pnpm bots --room <id> --count 20 --rate 5
 *   pnpm bots --rooms 10 --count 10 --duration 60     # new rooms, stop on its own
 *   pnpm bots --room <id> --chaos                      # sockets drop every 30–90 s
 *
 * Each bot moves a fake cursor over awareness at 30 Hz and inserts or deletes `debug-items` at
 * `--rate` ops/s. One bot per room writes `{ t, by }` into the `latency` map every second; the
 * others record how long it took to arrive. On Ctrl+C (or after `--duration`) every bot's doc
 * hash is compared, and the script exits 1 if any room diverged.
 *
 * Rooms are spread over worker threads (`--workers`, default: one per core, minus two for the
 * server and Postgres), because a single thread runs out of CPU applying fan-out before the
 * server does. The "bot loop p99" column shows when the bots themselves are the bottleneck.
 */
import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { parseArgs } from 'node:util';
import { Worker } from 'node:worker_threads';
import { createDb, rooms } from '@planted/db';
import { CreateRoomResponse, RoomId } from '@planted/schema';
import type { FromWorker, ToWorker, WorkerConfig, WorkerSample } from './bot-worker';

const envFile = new URL('../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { values: args } = parseArgs({
  options: {
    room: { type: 'string' },
    rooms: { type: 'string', default: '1' },
    count: { type: 'string', default: '20' },
    rate: { type: 'string', default: '5' },
    url: { type: 'string', default: process.env.VITE_API_URL ?? 'http://localhost:3000' },
    chaos: { type: 'boolean', default: false },
    'chaos-every': { type: 'string', default: '30-90' },
    duration: { type: 'string' },
    workers: { type: 'string' },
  },
});

const apiUrl = args.url.replace(/\/$/, '');
const botsPerRoom = Number(args.count);
const opsPerSec = Number(args.rate);
const roomCount = args.room ? 1 : Number(args.rooms);
const [chaosMinS, chaosMaxS] = args['chaos-every'].split('-').map(Number) as [number, number];
const REPORT_EVERY_MS = 5000;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? Number.NaN;
}

const median = (xs: number[]) =>
  percentile(
    [...xs].sort((a, b) => a - b),
    50,
  );

/** Same shape as the server's `newRoomId`: 16 random bytes, base62, 22 characters. */
function randomRoomId(): RoomId {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let n = 0n;
  for (const byte of crypto.getRandomValues(new Uint8Array(16))) n = (n << 8n) | BigInt(byte);
  let out = '';
  for (; n > 0n; n /= 62n) out = alphabet.charAt(Number(n % 62n)) + out;
  return RoomId.parse(out.padStart(22, '0'));
}

async function createRooms(count: number): Promise<string[]> {
  // POST /rooms allows 10 a minute, so several rooms go straight into the dev database.
  const url = process.env.DATABASE_URL;
  if (count === 1 || !url) {
    return Promise.all(
      Array.from({ length: count }, async () => {
        const res = await fetch(`${apiUrl}/rooms`, { method: 'POST' });
        if (!res.ok) throw new Error(`POST /rooms answered ${res.status}: ${await res.text()}`);
        return CreateRoomResponse.parse(await res.json()).roomId;
      }),
    );
  }
  const { db, close } = createDb(url);
  try {
    const ids = Array.from({ length: count }, randomRoomId);
    await db.insert(rooms).values(ids.map((id) => ({ id })));
    return ids;
  } finally {
    await close();
  }
}

type ServerStats = { process?: { rssBytes: number; cpuMicros: number; loopP99Ms?: number } };
async function serverStats(): Promise<ServerStats | null> {
  try {
    const res = await fetch(`${apiUrl}/debug/realtime`);
    return res.ok ? ((await res.json()) as ServerStats) : null;
  } catch {
    return null;
  }
}

const roomIds = args.room ? [args.room] : await createRooms(roomCount);
const workerCount = Math.max(
  1,
  Math.min(roomIds.length, Number(args.workers ?? Math.max(1, availableParallelism() - 2))),
);
const workers = Array.from({ length: workerCount }, (_, w) => {
  const config: WorkerConfig = {
    wsUrl: apiUrl.replace(/^http/, 'ws'),
    roomIds: roomIds.filter((_, i) => i % workerCount === w),
    botsPerRoom,
    opsPerSec,
    chaos: args.chaos ? { minS: chaosMinS, maxS: chaosMaxS } : null,
  };
  return new Worker(new URL('./bot-worker.ts', import.meta.url), { workerData: config });
});

/** Send `message` to every worker and collect one reply of type `type` from each. */
function ask<T extends FromWorker['type']>(
  message: ToWorker,
  type: T,
): Promise<Extract<FromWorker, { type: T }>[]> {
  return Promise.all(
    workers.map(
      (worker) =>
        new Promise<Extract<FromWorker, { type: T }>>((resolve) => {
          const onMessage = (reply: FromWorker) => {
            if (reply.type !== type) return;
            worker.off('message', onMessage);
            resolve(reply as Extract<FromWorker, { type: T }>);
          };
          worker.on('message', onMessage);
          worker.postMessage(message);
        }),
    ),
  );
}

for (const worker of workers) {
  worker.on('message', (reply: FromWorker) => {
    if (reply.type === 'error') console.error(reply.message);
  });
  worker.on('error', (err) => {
    console.error(err);
    process.exit(1);
  });
}

console.log(
  `${roomIds.length * botsPerRoom} bots in ${roomIds.length} room(s) on ${workerCount} worker(s), ${opsPerSec} ops/s each${args.chaos ? `, chaos every ${args['chaos-every']} s` : ''}`,
);
if (!args.room && roomIds[0]) {
  console.log(`watch: ${process.env.WEB_ORIGIN ?? 'http://localhost:5173'}/r/${roomIds[0]}/debug`);
}

const startedAt = Date.now();
let last = { at: Date.now(), ops: 0, frames: 0, cpu: null as number | null };
const summary = { p95: [] as number[], cpu: [] as number[], rss: [] as number[] };
let finishing = false;

async function report(): Promise<void> {
  const [samples, stats] = await Promise.all([ask({ type: 'report' }, 'sample'), serverStats()]);
  if (finishing) return;
  const now = Date.now();
  const seconds = (now - last.at) / 1000;
  const sum = (key: 'bots' | 'ops' | 'frames') =>
    samples.reduce((total, s: WorkerSample) => total + s[key], 0);
  const statuses: Record<string, number> = {};
  for (const s of samples) {
    for (const [status, n] of Object.entries(s.statuses)) {
      statuses[status] = (statuses[status] ?? 0) + n;
    }
  }
  const sorted = samples.flatMap((s) => s.latencies).sort((a, b) => a - b);
  const p95 = percentile(sorted, 95);
  const cpu = stats?.process?.cpuMicros ?? null;
  const cpuPct =
    cpu !== null && last.cpu !== null ? ((cpu - last.cpu) / 1e6 / seconds) * 100 : null;
  const rssMb = stats?.process ? stats.process.rssBytes / 1024 / 1024 : null;
  if (Number.isFinite(p95)) summary.p95.push(p95);
  if (cpuPct !== null) summary.cpu.push(cpuPct);
  if (rssMb !== null) summary.rss.push(rssMb);

  const ops = sum('ops');
  const frames = sum('frames');
  const notSynced = Object.entries(statuses)
    .filter(([status]) => status !== 'synced')
    .map(([status, n]) => ` ${status} ${n}`)
    .join('');
  const first = samples[0];
  console.log(
    [
      `[${String(Math.round((now - startedAt) / 1000)).padStart(4)}s]`,
      `bots ${statuses.synced ?? 0}/${sum('bots')} synced${notSynced}`,
      `ops/s ${((ops - last.ops) / seconds).toFixed(0)}`,
      `frames/s in ${Math.round((frames - last.frames) / seconds)}`,
      `latency p50 ${percentile(sorted, 50)} p95 ${p95} max ${sorted.at(-1) ?? Number.NaN} ms`,
      `bot loop p99 ${Math.round(Math.max(...samples.map((s) => s.loopP99Ms)))} ms`,
      `items ${first?.items ?? 0}`,
      `doc ${((first?.docBytes ?? 0) / 1024).toFixed(1)} kB`,
      cpuPct === null
        ? 'server n/a'
        : `server cpu ${cpuPct.toFixed(0)}% loop p99 ${Math.round(stats?.process?.loopP99Ms ?? Number.NaN)} ms rss ${rssMb?.toFixed(0)} MB`,
    ].join(' | '),
  );
  last = { at: now, ops, frames, cpu };
}

async function finish(): Promise<never> {
  if (finishing) return new Promise(() => {});
  finishing = true;
  console.log('\nstopping bots, waiting for sync to settle…');
  const done = await ask({ type: 'finish' }, 'done');
  let diverged = false;
  for (const { roomId, hashes } of done.flatMap((d) => d.rooms)) {
    const ok = Object.keys(hashes).length === 1;
    diverged ||= !ok;
    const detail = Object.entries(hashes)
      .map(([hash, n]) => `${hash}×${n}`)
      .join(', ');
    console.log(`${ok ? 'ok      ' : 'DIVERGED'} ${roomId} ${detail}`);
  }
  console.log(`settled in ${(Math.max(...done.map((d) => d.settleMs)) / 1000).toFixed(1)} s`);
  console.log(
    `summary: ${roomIds.length} rooms × ${botsPerRoom} bots, p95 latency (median of reports) ${median(summary.p95)} ms, server cpu (median) ${median(summary.cpu).toFixed(0)}%, rss max ${Math.max(...summary.rss).toFixed(0)} MB`,
  );
  process.exit(diverged ? 1 : 0);
}

setInterval(() => void report(), REPORT_EVERY_MS);
process.on('SIGINT', () => void finish());
if (args.duration) setTimeout(() => void finish(), Number(args.duration) * 1000);
