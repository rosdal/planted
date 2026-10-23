/**
 * The 0.4 chaos run: drawing bots reach the server through Toxiproxy, which adds the network
 * trouble a TCP proxy can (no packet loss, so these stand in for it): 150 ms ± 50 ms latency,
 * 256 KB/s bandwidth, frames sliced into small TCP segments, and a `reset_peer` on random
 * connections every 30–90 s. The server is restarted twice along the way.
 *
 *   pnpm db:up && docker compose -f docker-compose.chaos.yml up -d
 *   pnpm --filter @planted/scripts chaos                  # 20 bots, 30 minutes
 *   pnpm --filter @planted/scripts chaos --minutes 5      # a quick one
 *
 * Pass: every bot ends with the same doc hash, and after 15 s of quiet the doc loaded fresh
 * from Postgres has that hash too. Exits 1 otherwise. Server logs go to chaos-server.log.
 */
import { type ChildProcess, execSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { docHash } from '@planted/client';
import { createDb, roomDocs } from '@planted/db';
import { CreateRoomResponse } from '@planted/schema';
import { eq } from 'drizzle-orm';
import * as Y from 'yjs';

const envFile = new URL('../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { values: args } = parseArgs({
  options: {
    minutes: { type: 'string', default: '30' },
    bots: { type: 'string', default: '20' },
    restarts: { type: 'string', default: '2' },
    /** KB/s per connection and direction; 0 leaves the bandwidth toxic out. */
    bandwidth: { type: 'string', default: '256' },
  },
});

const SERVER_PORT = 3101;
const PROXY_PORT = 3100;
const TOXIPROXY = 'http://localhost:8474';
const serverUrl = `http://localhost:${SERVER_PORT}`;
const proxyUrl = `http://localhost:${PROXY_PORT}`;
const runMs = Number(args.minutes) * 60_000;
const restarts = Number(args.restarts);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is not set; copy .env.example to .env');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const rand = (min: number, max: number) => min + Math.random() * (max - min);
const log = (message: string) =>
  console.log(`[chaos ${new Date().toISOString().slice(11, 19)}] ${message}`);

async function toxiproxy(method: string, path: string, body?: unknown): Promise<void> {
  const res = await fetch(`${TOXIPROXY}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`toxiproxy ${method} ${path} answered ${res.status}: ${await res.text()}`);
  }
}

async function setUpProxy(): Promise<void> {
  try {
    await toxiproxy('DELETE', '/proxies/planted');
  } catch (err) {
    throw new Error(
      'Toxiproxy is not reachable on :8474; run docker compose -f docker-compose.chaos.yml up -d',
      { cause: err },
    );
  }
  await toxiproxy('POST', '/proxies', {
    name: 'planted',
    listen: `0.0.0.0:${PROXY_PORT}`,
    upstream: `host.docker.internal:${SERVER_PORT}`,
  });
  for (const stream of ['downstream', 'upstream'] as const) {
    const toxic = (type: string, attributes: Record<string, number>) =>
      toxiproxy('POST', '/proxies/planted/toxics', {
        name: `${type}_${stream}`,
        type,
        stream,
        toxicity: 1,
        attributes,
      });
    await toxic('latency', { latency: 150, jitter: 50 });
    if (Number(args.bandwidth) > 0) await toxic('bandwidth', { rate: Number(args.bandwidth) });
    await toxic('slicer', { average_size: 512, size_variation: 256, delay: 0 });
  }
}

/** Every 30–90 s, reset a random share of connections for a moment. */
function resetPeersNow(): { stop: () => void } {
  let timer: ReturnType<typeof setTimeout>;
  let stopped = false;
  const next = () => {
    timer = setTimeout(
      async () => {
        if (stopped) return;
        const toxicity = rand(0.1, 0.4);
        try {
          await toxiproxy('POST', '/proxies/planted/toxics', {
            name: 'reset',
            type: 'reset_peer',
            stream: 'downstream',
            toxicity,
            attributes: { timeout: 0 },
          });
          log(`reset_peer on ~${Math.round(toxicity * 100)}% of connections`);
          await sleep(1000);
          await toxiproxy('DELETE', '/proxies/planted/toxics/reset');
        } catch (err) {
          log(`reset_peer failed: ${String(err)}`);
        }
        next();
      },
      rand(30_000, 90_000),
    );
  };
  next();
  return {
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

const serverDir = fileURLToPath(new URL('../apps/server/', import.meta.url));
const serverLog = createWriteStream(fileURLToPath(new URL('./chaos-server.log', import.meta.url)));
const secret = randomBytes(32).toString('base64url');
let server: ChildProcess | null = null;

async function startServer(): Promise<void> {
  server = spawn(process.execPath, ['--enable-source-maps', 'dist/main.js'], {
    cwd: serverDir,
    env: {
      ...process.env,
      // Development keeps the bots' `latency` root type allowed and the debug routes on.
      NODE_ENV: 'development',
      SERVER_PORT: String(SERVER_PORT),
      SERVER_HOST: '0.0.0.0',
      LOG_LEVEL: 'info',
      ROOM_TOKEN_SECRET: secret,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.pipe(serverLog, { end: false });
  server.stderr?.pipe(serverLog, { end: false });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${serverUrl}/health`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await sleep(100);
  }
  throw new Error('server did not come up; see scripts/chaos-server.log');
}

async function stopServer(): Promise<void> {
  const proc = server;
  if (!proc) return;
  const exited = new Promise((resolve) => proc.once('exit', resolve));
  // A graceful SIGTERM on Linux and macOS; on Windows this is a hard kill, which is harsher.
  proc.kill('SIGTERM');
  await exited;
  server = null;
}

log('building the server');
execSync('pnpm --filter @planted/server build', { stdio: 'inherit' });
await setUpProxy();
await startServer();

const created = await fetch(`${serverUrl}/rooms`, { method: 'POST' });
if (!created.ok) throw new Error(`POST /rooms answered ${created.status}`);
const room = CreateRoomResponse.parse(await created.json());
log(`room ${room.roomId}, ${args.bots} bots for ${args.minutes} min through ${proxyUrl}`);

const bots = spawn(
  process.execPath,
  [
    '--import',
    'tsx',
    'bots.ts',
    '--url',
    proxyUrl,
    '--room',
    room.roomId,
    '--key',
    room.editKey,
    '--count',
    String(args.bots),
    '--mode',
    'draw',
    '--duration',
    String(runMs / 1000),
  ],
  { cwd: fileURLToPath(new URL('.', import.meta.url)), stdio: ['ignore', 'pipe', 'inherit'] },
);
const botOutput: string[] = [];
bots.stdout?.on('data', (chunk: Buffer) => {
  const text = chunk.toString();
  botOutput.push(text);
  process.stdout.write(text);
});
const botsExited = new Promise<number>((resolve) => bots.on('exit', (code) => resolve(code ?? 1)));

const resets = resetPeersNow();
for (let i = 1; i <= restarts; i++) {
  await sleep(runMs / (restarts + 1));
  log(`restarting the server (${i} of ${restarts})`);
  await stopServer();
  await sleep(2000);
  await startServer();
  log('server back');
}
// The bots stop editing at the end of the run and then wait for agreement; the resets stop
// with them, so the check runs on a quiet network as the pass criterion says.
await sleep(Math.max(0, runMs - (restarts * runMs) / (restarts + 1)));
resets.stop();

const botExit = await botsExited;

// "ok      <room> <hash>×20": every bot agreed on one hash.
const line = botOutput
  .join('')
  .split('\n')
  .find((l) => l.includes(room.roomId) && /^(ok|DIVERGED|LOST)/.test(l));
const botHash = line?.match(/ ([0-9a-f]{8})×\d+/)?.[1] ?? null;
log(`bots finished with exit ${botExit}: ${line?.trim() ?? 'no result line'}`);

log('waiting 15 s for the last save');
await sleep(15_000);
const { db, close } = createDb(databaseUrl);
const [row] = await db
  .select({ ydoc: roomDocs.ydoc })
  .from(roomDocs)
  .where(eq(roomDocs.roomId, room.roomId));
await close();
const fresh = new Y.Doc();
if (row) Y.applyUpdate(fresh, row.ydoc);
const storedHash = docHash(fresh);
log(`doc loaded from Postgres: hash ${storedHash}, ${fresh.getMap('objects').size} objects`);

await stopServer();
await toxiproxy('DELETE', '/proxies/planted');
serverLog.end();

const pass = botExit === 0 && botHash !== null && botHash === storedHash;
log(pass ? 'PASS' : `FAIL (bots ${botHash ?? 'diverged'}, Postgres ${storedHash})`);
process.exit(pass ? 0 : 1);
