/**
 * Gate 1 measurement for 0.3 (docs/todo/v0.3.md, sections 7 and 8), automated so it can be
 * repeated: 8 drawing bots plus two Playwright-driven "humans" in real Chrome windows, one of
 * which keeps panning and zooming while it draws. Reads the board's own overlay numbers.
 *
 *   pnpm --filter @planted/web build && pnpm --filter @planted/web preview --port 5199
 *   pnpm --filter @planted/scripts gate1 --web http://localhost:5199 --api http://localhost:5198
 *
 * Point `--web` at a production build (`vite preview`), not the dev server. Options:
 *   --minutes 5      length of the main run
 *   --bots 8         drawing bots in the room
 *   --seed 2000      strokes written into the room before the fit → 8× pan test
 *   --throttle 4     DevTools CPU throttling on the measured window (stretch goal)
 *   --trace <file>   after the run, save a 30 s Chrome performance trace (bots and A busy)
 *
 * The scripted humans are not people: they draw, pan and zoom on a loop with no pauses, which
 * is harder on the board than a person, but they don't judge "feels laggy". Do that by hand.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  cachedTokens,
  commitStroke,
  fetchRoomToken,
  newObjectId,
  RoomClient,
  type WebSocketCtor,
} from '@planted/client';
import { TEST_FLOOR, USER_COLOURS } from '@planted/schema';
import { type Browser, type BrowserContext, chromium, type Page } from '@playwright/test';
import WebSocket from 'ws';

const { values: args } = parseArgs({
  options: {
    web: { type: 'string', default: 'http://localhost:5199' },
    api: { type: 'string', default: 'http://localhost:5198' },
    minutes: { type: 'string', default: '5' },
    bots: { type: 'string', default: '8' },
    seed: { type: 'string', default: '2000' },
    throttle: { type: 'string', default: '1' },
    trace: { type: 'string' },
    width: { type: 'string', default: '1920' },
    height: { type: 'string', default: '1080' },
  },
});

const runMs = Number(args.minutes) * 60_000;
const width = Number(args.width);
const height = Number(args.height);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const rand = (min: number, max: number) => min + Math.random() * (max - min);

type Stats = {
  scale: number;
  fps: number;
  p95FrameMs: number;
  longestFrameMs: number;
  droppedShare: number;
  objects: number;
  liveStrokes: number;
  cursors: number;
  docBytes: number;
  heapMb: number | null;
};

type Room = { roomId: string; editKey: string };

async function newRoom(): Promise<Room> {
  const res = await fetch(`${args.api}/rooms`, { method: 'POST' });
  if (!res.ok) throw new Error(`POST /rooms answered ${res.status}`);
  return (await res.json()) as Room;
}

function startBots(
  { roomId, editKey }: Room,
  seconds: number,
): { proc: ChildProcess; output: string[]; exited: Promise<void> } {
  const output: string[] = [];
  const proc = spawn(
    'pnpm',
    [
      'exec',
      'tsx',
      'bots.ts',
      '--url',
      args.api,
      '--room',
      roomId,
      '--key',
      editKey,
      '--count',
      args.bots,
      '--mode',
      'draw',
      '--duration',
      String(seconds),
    ],
    // shell: pnpm is a .cmd on Windows. Every argument is ours, nothing user-supplied.
    { cwd: fileURLToPath(new URL('.', import.meta.url)), shell: true },
  );
  proc.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    output.push(text);
    process.stdout.write(`  bots: ${text}`);
  });
  proc.stderr?.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  // Captured now: an 'exit' listener added after the process ended would never fire.
  const exited = new Promise<void>((resolve) => proc.on('exit', () => resolve()));
  return { proc, output, exited };
}

async function openHuman(
  browser: Browser,
  { roomId, editKey }: Room,
  name: string,
  bounds: { left: number; top: number; width: number; height: number },
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: null });
  // Long animation frames with their script time: script-heavy ones are the board's own work,
  // script-free ones are rendering, the GPU or the machine.
  await context.addInitScript(() => {
    const store = window as unknown as { __loaf: { at: number; ms: number; script: number }[] };
    store.__loaf = [];
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as unknown as {
          startTime: number;
          duration: number;
          scripts: { duration: number }[];
        }[]) {
          const script = e.scripts.reduce((sum, x) => sum + x.duration, 0);
          store.__loaf.push({ at: e.startTime, ms: e.duration, script });
        }
      }).observe({ type: 'long-animation-frame', buffered: true });
    } catch {
      // Not supported: the summary just has no long-frame breakdown.
    }
  });
  await context.addInitScript(
    (identity) => localStorage.setItem('planted.guest', JSON.stringify(identity)),
    { name, colour: name === 'Human A' ? USER_COLOURS[3] : USER_COLOURS[6] },
  );
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const { windowId } = (await cdp.send('Browser.getWindowForTarget')) as { windowId: number };
  await cdp.send('Browser.setWindowBounds', {
    windowId,
    bounds,
  });
  await page.goto(`${args.web}/r/${roomId}?perf=1#k=${editKey}`);
  await page.getByRole('status').filter({ hasText: 'Live' }).waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => window.__board !== undefined);
  return { context, page };
}

/** Viewport centre, below the header and away from the toolbar. */
async function centre(page: Page): Promise<{ x: number; y: number }> {
  const size = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  return { x: size.w / 2, y: size.h / 2 + 28 };
}

async function drawStroke(page: Page, x: number, y: number, points = 40): Promise<void> {
  await page.mouse.move(x, y);
  await page.mouse.down();
  const angle = rand(0, Math.PI * 2);
  for (let i = 1; i <= points; i++) {
    const t = i / points;
    await page.mouse.move(
      x + Math.cos(angle) * t * 220 + Math.sin(t * 9) * 25,
      y + Math.sin(angle) * t * 220 + Math.cos(t * 7) * 25,
    );
    await sleep(8);
  }
  await page.mouse.up();
}

/** Human A: draw, pan with the middle button, zoom in and out with the wheel; never idle. */
async function busyHuman(page: Page, until: () => boolean): Promise<number> {
  const c = await centre(page);
  let strokes = 0;
  while (!until()) {
    await drawStroke(page, c.x + rand(-300, 300), c.y + rand(-200, 200));
    strokes++;
    await page.mouse.move(c.x, c.y);
    await page.mouse.down({ button: 'middle' });
    const dx = rand(-200, 200);
    const dy = rand(-150, 150);
    for (let i = 1; i <= 30; i++) {
      await page.mouse.move(c.x + (dx * i) / 30, c.y + (dy * i) / 30);
      await sleep(8);
    }
    await page.mouse.up({ button: 'middle' });
    const zoomIn = Math.random() < 0.5;
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, zoomIn ? -100 : 100);
      await sleep(30);
    }
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, zoomIn ? 100 : -100);
      await sleep(30);
    }
    if (Math.random() < 0.2) await page.keyboard.press('0');
  }
  return strokes;
}

/** Human B: a stroke every couple of seconds, and the odd undo. */
async function calmHuman(page: Page, until: () => boolean): Promise<number> {
  const c = await centre(page);
  let net = 0;
  while (!until()) {
    await drawStroke(page, c.x + rand(-400, 400), c.y + rand(-250, 250), 30);
    net++;
    if (Math.random() < 0.1) {
      await sleep(500);
      await page.keyboard.press('Control+z');
      net--;
    }
    await sleep(rand(1000, 3000));
  }
  return net;
}

const statsOf = (page: Page) => page.evaluate(() => window.__board?.stats() as unknown as Stats);

/** Long animation frames since the last call: count, worst, and how much of them was script. */
async function takeLoaf(page: Page): Promise<string> {
  const loaf = await page.evaluate(() => {
    const store = window as unknown as { __loaf: { ms: number; script: number }[] };
    const out = store.__loaf;
    store.__loaf = [];
    return out;
  });
  if (loaf.length === 0) return 'loaf 0';
  const worst = loaf.reduce((w, f) => (f.ms > w.ms ? f : w));
  const script = loaf.reduce((sum, f) => sum + f.script, 0);
  const total = loaf.reduce((sum, f) => sum + f.ms, 0);
  return `loaf ${loaf.length} worst ${worst.ms.toFixed(0)} ms (script ${worst.script.toFixed(0)}) script share ${((script / total) * 100).toFixed(0)}%`;
}

async function seedStrokes({ roomId, editKey }: Room, count: number): Promise<void> {
  if (count <= 0) return;
  const client = new RoomClient({
    url: args.api.replace(/^http/, 'ws'),
    roomId,
    getToken: cachedTokens(() => fetchRoomToken(args.api, roomId, editKey)),
    WebSocketImpl: WebSocket as unknown as WebSocketCtor,
  });
  while (client.status !== 'synced') await sleep(50);
  for (let i = 0; i < count; i++) {
    const x = rand(0.12, 0.88);
    const y = rand(0.12, 0.88);
    const a = rand(0, Math.PI * 2);
    const points = Array.from({ length: 30 }, (_, k) => [
      x + Math.cos(a) * k * 0.002 + Math.sin(k / 3) * 0.003,
      y + Math.sin(a) * k * 0.002 + Math.cos(k / 4) * 0.003,
    ]).flat();
    commitStroke(client.doc, {
      id: newObjectId(),
      floor: TEST_FLOOR,
      colour: USER_COLOURS[i % USER_COLOURS.length] ?? '#57ab5a',
      width: 0.002,
      points,
      epsilon: 0.0005,
      by: 'seed',
    });
    if (i % 200 === 199) await sleep(100);
  }
  await sleep(2000);
  client.destroy();
}

/** Pan for `ms` at the current zoom and report the overlay's frame numbers for that window. */
async function panPhase(page: Page, ms: number): Promise<Stats> {
  const c = await centre(page);
  await page.evaluate(() => window.__board?.resetLongestFrame());
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await page.mouse.move(c.x - 150, c.y);
    await page.mouse.down({ button: 'middle' });
    for (let i = 1; i <= 30; i++) {
      await page.mouse.move(c.x - 150 + i * 10, c.y + Math.sin(i / 5) * 40);
      await sleep(8);
    }
    for (let i = 29; i >= 0; i--) {
      await page.mouse.move(c.x - 150 + i * 10, c.y + Math.sin(i / 5) * 40);
      await sleep(8);
    }
    await page.mouse.up({ button: 'middle' });
  }
  return statsOf(page);
}

const room = await newRoom();
console.log(`room ${room.roomId}`);
const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  // Two big WebGL windows overlap on most screens; without these Chrome throttles the one that
  // is covered (down to a few fps), which measures the window manager, not the board.
  args: [
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
  ],
});
const version = browser.version();
// A is the measured reference window; B is a second person in a smaller window.
const a = await openHuman(browser, room, 'Human A', { left: 0, top: 0, width, height });
const b = await openHuman(browser, room, 'Human B', {
  left: 120,
  top: 120,
  width: 1280,
  height: 800,
});
// A is measured: bring it to the front so the compositor doesn't throttle it.
await a.page.bringToFront();
if (Number(args.throttle) > 1) {
  const cdp = await a.context.newCDPSession(a.page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(args.throttle) });
}

const bots = startBots(room, runMs / 1000);
const startedAt = Date.now();
const done = () => Date.now() - startedAt > runMs;
await sleep(1000);
await a.page.evaluate(() => window.__board?.resetLongestFrame());

const samples: Stats[] = [];
const sampler = setInterval(() => {
  void Promise.all([statsOf(a.page), takeLoaf(a.page)]).then(([s, loaf]) => {
    samples.push(s);
    const at = Math.round((Date.now() - startedAt) / 1000);
    console.log(
      `[${String(at).padStart(4)}s] zoom ${s.scale.toFixed(2)} fps ${s.fps.toFixed(0)} p95 ${s.p95FrameMs.toFixed(1)} ms longest ${s.longestFrameMs.toFixed(1)} ms dropped ${(s.droppedShare * 100).toFixed(1)}% objects ${s.objects} live ${s.liveStrokes} cursors ${s.cursors} heap ${s.heapMb?.toFixed(0) ?? 'n/a'} MB | ${loaf}`,
    );
  });
}, 5000);

const [humanAStrokes, humanBNet] = await Promise.all([
  busyHuman(a.page, done),
  calmHuman(b.page, done),
]);
clearInterval(sampler);
const runEnd = await statsOf(a.page);

await bots.exited;
await sleep(2000);
const hashes = await Promise.all(
  [a.page, b.page].map((p) => p.evaluate(() => window.__board?.docHash())),
);
const counts = await Promise.all(
  [a.page, b.page].map((p) => p.evaluate(() => window.__board?.objectCount())),
);
const botLine = bots.output.join('').match(/^(ok|LOST|DIVERGED).*$/m)?.[0] ?? '(no bot result)';
const botHash = botLine.match(/ ([0-9a-f]{8})×/)?.[1];

// The trace is its own phase: recording one during the main run (hundreds of MB through CDP)
// stalled the whole machine and wrecked the numbers it was meant to explain.
if (args.trace) {
  const stopTracing = Date.now() + 30_000;
  const traceBots = startBots(room, 32);
  // The default DevTools categories made a 400 MB file; these still load in the Performance panel.
  await browser.startTracing(a.page, {
    path: args.trace,
    screenshots: false,
    categories: [
      'devtools.timeline',
      'disabled-by-default-devtools.timeline',
      'disabled-by-default-devtools.timeline.frame',
      'blink.user_timing',
      'v8.execute',
      'gpu',
    ],
  });
  await Promise.all([busyHuman(a.page, () => Date.now() > stopTracing), sleep(30_000)]);
  await browser.stopTracing();
  await traceBots.exited;
  console.log(`trace saved to ${args.trace}`);
}

// Gate item 6: 2,000+ strokes on screen, pan at fit and at 8×. One viewer per GPU, as in real
// use: B's window would otherwise render all the same strokes on the same GPU.
await b.context.close();
await seedStrokes(room, Number(args.seed));
// Measure panning, not the initial build: wait until the scene holds every object and the
// stream of incoming updates has stopped.
await a.page.waitForFunction(
  () => {
    const s = window.__board?.stats();
    return s && s.objects === window.__board?.objectCount() && Number(s.framesInPerSec) < 5;
  },
  null,
  { timeout: 60_000, polling: 1000 },
);
await a.page.keyboard.press('0');
await sleep(1500);
const atFit = await panPhase(a.page, 15_000);
const c = await centre(a.page);
await a.page.mouse.move(c.x, c.y);
for (let i = 0; i < 40; i++) await a.page.mouse.wheel(0, -100);
await sleep(1000);
const atEight = await panPhase(a.page, 15_000);
const zoomShot = args.trace ? args.trace.replace(/\.json$/, '') : 'gate1';
await a.page.screenshot({ path: `${zoomShot}-8x.png` });
await a.page.keyboard.press('0');
await sleep(500);
await a.page.screenshot({ path: `${zoomShot}-fit.png` });

const p95s = samples.map((s) => s.p95FrameMs).sort((x, y) => x - y);
const summary = {
  browser: `Chrome ${version}`,
  window: `${width}×${height}`,
  cpuThrottle: Number(args.throttle),
  minutes: Number(args.minutes),
  bots: Number(args.bots),
  run: {
    worstP95FrameMs: p95s.at(-1),
    medianP95FrameMs: p95s[Math.floor(p95s.length / 2)],
    longestFrameMs: runEnd.longestFrameMs,
    worstDroppedShare: Math.max(...samples.map((s) => s.droppedShare)),
    objectsAtEnd: runEnd.objects,
    heapMb: runEnd.heapMb,
  },
  convergence: {
    pageHashes: hashes,
    botHash,
    objectCounts: counts,
    botLine,
    humanAStrokes,
    humanBNet,
  },
  strokesOnScreen: { objects: atFit.objects, fit: atFit, eightX: atEight },
};
console.log(JSON.stringify(summary, null, 2));
await browser.close();
process.exit(0);
