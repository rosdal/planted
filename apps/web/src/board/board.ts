import {
  createUndoManager,
  docHash,
  type LiveStroke,
  objectsOf,
  type RoomClient,
} from '@planted/client';
import { Application, Container, CullerPlugin, extensions, type Ticker } from 'pixi.js';
import * as Y from 'yjs';
import { CameraController } from './camera';
import { type Point, screenToMap } from './coords';
import { CursorLayer, installTagFont } from './render/cursors';
import { LocalLiveStroke, RemoteLiveStrokes } from './render/live';
import { MapLayer } from './render/map';
import { StrokeLayer } from './render/stroke';
import { SceneStore } from './scene-store';
import { PenTool } from './tools/pen';
import { bindUndoKeys } from './undo';

// Off-screen strokes are skipped by the renderer; registered once for every Application.
extensions.add(CullerPlugin);

/** Awareness sends (cursor, live stroke) at most this often: 30 Hz. */
const PRESENCE_MS = 33;
/** Frame-time window for the overlay's p95. */
const FRAME_WINDOW_MS = 5000;
/** The first second is shader compiles and the initial build; it doesn't count as a hitch. */
const WARMUP_MS = 1000;

export type BoardIdentity = () => { name: string; colour: string };
/** True for viewers: no pen, no undo. Read on every input, so a role change applies at once. */
export type BoardReadOnly = () => boolean;

export type BoardStats = {
  fps: number;
  p95FrameMs: number;
  longestFrameMs: number;
  /** Frames over 1.5× the median frame time, as a share of the last 5 s. */
  droppedShare: number;
  /** Camera zoom: world → screen scale. */
  scale: number;
  objects: number;
  liveStrokes: number;
  cursors: number;
  docBytes: number;
  framesInPerSec: number;
  framesOutPerSec: number;
  heapMb: number | null;
};

let fontReady: Promise<void> | null = null;

/** Cursor and live stroke for awareness, sent together in one frame at most every 33 ms. */
class Presence {
  #cursor: Point | null = null;
  #live: LiveStroke | null = null;
  #dirty = false;
  #lastSentAt = Number.NEGATIVE_INFINITY;
  readonly #client: RoomClient;

  constructor(client: RoomClient) {
    this.#client = client;
  }

  setCursor(cursor: Point | null): void {
    const prev = this.#cursor;
    if (prev === cursor || (prev && cursor && prev.x === cursor.x && prev.y === cursor.y)) return;
    this.#cursor = cursor;
    this.#dirty = true;
  }

  setLive(live: LiveStroke | null): void {
    this.#live = live;
    this.#dirty = true;
    // Clearing the live stroke goes out at once, in the same tick as its commit.
    if (live === null) this.send(performance.now());
  }

  tick(now: number): void {
    if (this.#dirty && now - this.#lastSentAt >= PRESENCE_MS) this.send(now);
  }

  send(now: number): void {
    if (!this.#dirty) return;
    this.#dirty = false;
    this.#lastSentAt = now;
    const { awareness } = this.#client;
    awareness.setLocalState({
      ...awareness.getLocalState(),
      cursor: this.#cursor,
      live: this.#live,
    });
  }
}

/** Ring of recent frame times for the overlay. */
class FrameStats {
  readonly #frames: { at: number; ms: number }[] = [];
  #longest = 0;
  #startedAt: number | null = null;

  push(now: number, ms: number): void {
    this.#startedAt ??= now;
    this.#frames.push({ at: now, ms });
    while ((this.#frames[0]?.at ?? now) < now - FRAME_WINDOW_MS) this.#frames.shift();
    if (now - this.#startedAt > WARMUP_MS) this.#longest = Math.max(this.#longest, ms);
  }

  /** Share of frames in the window that took over 1.5 refresh intervals (a missed vsync). */
  get droppedShare(): number {
    if (this.#frames.length === 0) return 0;
    const sorted = this.#frames.map((f) => f.ms).sort((a, b) => a - b);
    const interval = sorted[Math.floor(sorted.length / 2)] ?? 16.7;
    return this.#frames.filter((f) => f.ms > interval * 1.5).length / this.#frames.length;
  }

  get fps(): number {
    const first = this.#frames[0];
    const last = this.#frames.at(-1);
    if (!first || !last || last.at === first.at) return 0;
    return ((this.#frames.length - 1) * 1000) / (last.at - first.at);
  }

  get p95(): number {
    const sorted = this.#frames.map((f) => f.ms).sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
  }

  get longest(): number {
    return this.#longest;
  }

  resetLongest(): void {
    this.#longest = 0;
  }
}

/**
 * The board: one Pixi `Application` driven imperatively, so React never renders per frame.
 *
 * Scene graph: `world` (camera transform) holds `mapLayer`, `strokeLayer` and `liveLayer`;
 * `cursorLayer` sits outside it in screen space so name tags never scale. Each frame the ticker
 * flushes doc changes, applies the camera, draws live strokes and cursors, and sends presence.
 */
export class Board {
  readonly undo: Y.UndoManager;
  readonly #client: RoomClient;
  readonly #host: HTMLElement;
  readonly #identity: BoardIdentity;
  readonly #readOnly: BoardReadOnly;
  readonly #app = new Application();
  readonly #frames = new FrameStats();
  readonly #presence: Presence;
  readonly #cleanups: (() => void)[] = [];
  #initialised = false;
  #destroyed = false;
  #camera: CameraController | null = null;
  #scene: SceneStore | null = null;
  #remoteLive: RemoteLiveStrokes | null = null;
  #cursors: CursorLayer | null = null;
  #localLive: LocalLiveStroke | null = null;
  #rate = { at: performance.now(), in: 0, out: 0, inPerSec: 0, outPerSec: 0 };
  #docBytes = { at: 0, bytes: 0 };

  constructor(
    host: HTMLElement,
    client: RoomClient,
    identity: BoardIdentity,
    readOnly: BoardReadOnly,
  ) {
    this.#host = host;
    this.#client = client;
    this.#identity = identity;
    this.#readOnly = readOnly;
    this.#presence = new Presence(client);
    this.undo = createUndoManager(client.doc);
  }

  /** Resolves once mounted, or once torn down if `destroy()` came first (StrictMode). */
  async init(): Promise<void> {
    const app = this.#app;
    await app.init({
      resizeTo: this.#host,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
      backgroundAlpha: 0,
      // Input goes through DOM listeners on the canvas; Pixi's event system isn't needed.
      eventFeatures: { move: false, globalMove: false, click: false, wheel: false },
    });
    if (this.#destroyed) {
      app.destroy({ removeView: true }, { children: true, texture: false });
      return;
    }
    fontReady ??= installTagFont();
    await fontReady;
    if (this.#destroyed) {
      app.destroy({ removeView: true }, { children: true, texture: false });
      return;
    }
    this.#initialised = true;
    this.#mount();
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    for (const cleanup of this.#cleanups.splice(0)) cleanup();
    this.undo.destroy();
    this.#scene?.destroy();
    this.#remoteLive?.destroy();
    this.#cursors?.destroy();
    this.#camera?.destroy();
    const { awareness } = this.#client;
    const local = awareness.getLocalState();
    if (local) awareness.setLocalState({ ...local, cursor: null, live: null });
    // Map art is cached by Assets and shared with the next mount; don't destroy textures.
    if (this.#initialised)
      this.#app.destroy({ removeView: true }, { children: true, texture: false });
  }

  stats(): BoardStats {
    const now = performance.now();
    const { stats } = this.#client;
    const rate = this.#rate;
    if (now - rate.at >= 1000) {
      const seconds = (now - rate.at) / 1000;
      rate.inPerSec = (stats.framesReceived - rate.in) / seconds;
      rate.outPerSec = (stats.framesSent - rate.out) / seconds;
      rate.in = stats.framesReceived;
      rate.out = stats.framesSent;
      rate.at = now;
    }
    if (now - this.#docBytes.at >= 1000) {
      this.#docBytes = { at: now, bytes: Y.encodeStateAsUpdate(this.#client.doc).byteLength };
    }
    const memory = (performance as { memory?: { usedJSHeapSize: number } }).memory;
    return {
      fps: this.#frames.fps,
      p95FrameMs: this.#frames.p95,
      longestFrameMs: this.#frames.longest,
      droppedShare: this.#frames.droppedShare,
      scale: this.#camera?.camera.scale ?? 0,
      objects: this.#scene?.size ?? 0,
      liveStrokes: (this.#remoteLive?.size ?? 0) + (this.#localLive?.active ? 1 : 0),
      cursors: this.#cursors?.visibleCount ?? 0,
      docBytes: this.#docBytes.bytes,
      framesInPerSec: rate.inPerSec,
      framesOutPerSec: rate.outPerSec,
      heapMb: memory ? memory.usedJSHeapSize / 1024 / 1024 : null,
    };
  }

  /** For measurement runs: forget the longest frame so far. */
  resetLongestFrame(): void {
    this.#frames.resetLongest();
  }

  get fps(): number {
    return this.#frames.fps;
  }

  get objectCount(): number {
    return objectsOf(this.#client.doc).size;
  }

  /** `by` of every object, sorted: lets tests check whose strokes survived an undo. */
  get authors(): string[] {
    return [...objectsOf(this.#client.doc).values()].map((o) => String(o.get('by'))).sort();
  }

  get docHash(): string {
    return docHash(this.#client.doc);
  }

  #mount(): void {
    const app = this.#app;
    const canvas = app.canvas;
    canvas.style.display = 'block';
    canvas.style.touchAction = 'none';
    canvas.tabIndex = -1;
    this.#host.appendChild(canvas);
    app.stage.eventMode = 'none';

    const doc = this.#client.doc;
    const objects = objectsOf(doc);
    const camera = new CameraController(canvas);
    // Render groups: the camera moves `world` as a GPU transform instead of re-transforming
    // every vertex under it, and live strokes changing every frame don't make Pixi re-upload
    // the committed strokes' buffers. See StrokeLayer for the per-tile groups.
    const world = new Container({ label: 'world', isRenderGroup: true });
    const map = new MapLayer();
    const strokes = new StrokeLayer();
    const liveLayer = new Container({ label: 'liveLayer', isRenderGroup: true });
    const remoteLive = new RemoteLiveStrokes(this.#client.awareness, objects);
    const localLive = new LocalLiveStroke();
    const cursors = new CursorLayer(this.#client.awareness);
    liveLayer.addChild(remoteLive.container, localLive.container);
    world.addChild(map.container, strokes.container, liveLayer);
    app.stage.addChild(world, cursors.container);
    this.#camera = camera;
    this.#remoteLive = remoteLive;
    this.#cursors = cursors;
    this.#localLive = localLive;
    this.#scene = new SceneStore(objects, strokes);

    void map.loadFloor().catch((err: unknown) => console.error('board: floor failed to load', err));
    this.#watchTheme(map);
    this.#watchResolution();

    const rect = { left: 0, top: 0 };
    const measure = () => {
      const r = canvas.getBoundingClientRect();
      rect.left = r.left;
      rect.top = r.top;
    };
    measure();
    const toScreen = (clientX: number, clientY: number) => ({
      x: clientX - rect.left,
      y: clientY - rect.top,
    });

    const pen = new PenTool({
      doc,
      camera,
      live: localLive,
      identity: this.#identity,
      toScreen,
      setLive: (live) => this.#presence.setLive(live),
    });
    this.#bindInput(canvas, camera, pen, toScreen, measure);
    this.#cleanups.push(bindUndoKeys(this.undo, () => pen.drawing || this.#readOnly()));

    let viewport = { width: 0, height: 0 };
    app.ticker.add((ticker: Ticker) => {
      const now = performance.now();
      const { width, height } = app.screen;
      if (width !== viewport.width || height !== viewport.height) {
        viewport = { width, height };
        camera.resize(viewport);
        measure();
      }
      this.#scene?.flush();
      const cam = camera.camera;
      world.position.set(cam.x, cam.y);
      world.scale.set(cam.scale);
      localLive.render();
      remoteLive.render(now);
      cursors.render(now, ticker.deltaMS, cam, viewport);
      pen.sendLive();
      this.#presence.tick(now);
      this.#frames.push(now, ticker.deltaMS);
    });
  }

  #bindInput(
    canvas: HTMLCanvasElement,
    camera: CameraController,
    pen: PenTool,
    toScreen: (x: number, y: number) => Point,
    measure: () => void,
  ): void {
    const presence = this.#presence;
    const onDown = (e: PointerEvent) => {
      measure();
      const screen = toScreen(e.clientX, e.clientY);
      if (camera.pointerDown(e, screen)) return;
      if (!this.#readOnly()) pen.pointerDown(e, canvas);
    };
    const onMove = (e: PointerEvent) => {
      const screen = toScreen(e.clientX, e.clientY);
      if (!camera.pointerMove(e, screen)) pen.pointerMove(e);
      presence.setCursor(screenToMap(camera.camera, screen));
    };
    const onUp = (e: PointerEvent) => {
      if (!camera.pointerUp(e)) pen.pointerUp(e);
    };
    const onLeave = () => {
      if (!pen.drawing && !camera.panning) presence.setCursor(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && pen.cancel()) e.preventDefault();
    };
    const onVisibility = () => {
      if (document.visibilityState !== 'hidden') return;
      pen.commit();
      presence.setCursor(null);
      presence.send(performance.now());
    };
    const noMenu = (e: Event) => e.preventDefault();
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('lostpointercapture', onUp);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('contextmenu', noMenu);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', measure, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    this.#cleanups.push(() => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('lostpointercapture', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('contextmenu', noMenu);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', measure);
      document.removeEventListener('visibilitychange', onVisibility);
    });
  }

  /** Map ink follows the theme's text colour, live when the OS switches dark ↔ light. */
  #watchTheme(map: MapLayer): void {
    const apply = () => {
      const ink = getComputedStyle(document.documentElement).getPropertyValue('--fg').trim();
      map.setInk(ink || '#ededed');
    };
    apply();
    const query = window.matchMedia('(prefers-color-scheme: light)');
    query.addEventListener('change', apply);
    this.#cleanups.push(() => query.removeEventListener('change', apply));
  }

  /** Moving the window to a monitor with another pixel ratio re-renders at the new density. */
  #watchResolution(): void {
    let query: MediaQueryList | null = null;
    const onChange = () => {
      const resolution = window.devicePixelRatio || 1;
      const { width, height } = this.#app.screen;
      this.#app.renderer.resize(width, height, resolution);
      listen();
    };
    const listen = () => {
      query?.removeEventListener('change', onChange);
      query = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      query.addEventListener('change', onChange);
    };
    listen();
    this.#cleanups.push(() => query?.removeEventListener('change', onChange));
  }
}
