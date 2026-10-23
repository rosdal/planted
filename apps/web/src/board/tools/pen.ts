import { commitStroke, type LiveStroke, newObjectId, rdp } from '@planted/client';
import { TEST_FLOOR } from '@planted/schema';
import type * as Y from 'yjs';
import type { CameraController } from '../camera';
import { type Point, screenPxToMap, screenToMap } from '../coords';
import type { LocalLiveStroke } from '../render/live';

/** Points closer than this on screen to the previous one are dropped while drawing. */
const MIN_STEP_PX = 0.75;
/** Pen width on screen at the zoom the stroke started at. */
const WIDTH_PX = 3;
/** Live strokes over awareness: simplified at this epsilon and capped, to keep frames small. */
const LIVE_EPSILON_PX = 0.5;
const LIVE_MAX_POINTS = 1000;
const MIN_WIDTH = 0.0002;
const MAX_WIDTH = 0.02;

export type PenContext = {
  doc: Y.Doc;
  camera: CameraController;
  live: LocalLiveStroke;
  /** Current user name and colour, read at stroke start (colour) and commit (name). */
  identity: () => { name: string; colour: string };
  /** Screen position of a client point, relative to the canvas. */
  toScreen: (clientX: number, clientY: number) => Point;
  /** Publish this user's live stroke (or null) through awareness. */
  setLive: (live: LiveStroke | null) => void;
};

type Drawing = {
  id: string;
  pointerId: number;
  colour: string;
  width: number;
  points: number[];
  lastScreen: Point;
  /** Points added since the last live send. */
  dirty: boolean;
};

/** Round to 1e-5 map units (a 25th of a world unit): shorter JSON, no visible change. */
const round = (n: number) => Math.round(n * 1e5) / 1e5;

/**
 * The pen: pointer input into a local point buffer, drawn every frame by `LocalLiveStroke`,
 * streamed at 30 Hz through awareness for everyone else, and committed as one simplified
 * stroke on pointer up.
 */
export class PenTool {
  #drawing: Drawing | null = null;
  readonly #ctx: PenContext;

  constructor(ctx: PenContext) {
    this.#ctx = ctx;
  }

  get drawing(): boolean {
    return this.#drawing !== null;
  }

  pointerDown(event: PointerEvent, target: Element): void {
    // Primary button only: right-click and the pen's eraser end are for later tools.
    if (event.button !== 0 || this.#ctx.camera.spaceHeld || this.#drawing) return;
    target.setPointerCapture(event.pointerId);
    const { camera } = this.#ctx;
    const screen = this.#ctx.toScreen(event.clientX, event.clientY);
    const p = screenToMap(camera.camera, screen);
    const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, screenPxToMap(camera.camera, WIDTH_PX)));
    const drawing: Drawing = {
      id: newObjectId(),
      pointerId: event.pointerId,
      colour: this.#ctx.identity().colour,
      width,
      points: [p.x, p.y],
      lastScreen: screen,
      dirty: true,
    };
    this.#drawing = drawing;
    this.#ctx.live.begin(drawing.colour, drawing.width, drawing.points);
  }

  pointerMove(event: PointerEvent): void {
    const drawing = this.#drawing;
    if (!drawing || event.pointerId !== drawing.pointerId) return;
    const camera = this.#ctx.camera.camera;
    const events = event.getCoalescedEvents?.() ?? [];
    for (const e of events.length > 0 ? events : [event]) {
      const screen = this.#ctx.toScreen(e.clientX, e.clientY);
      const dx = screen.x - drawing.lastScreen.x;
      const dy = screen.y - drawing.lastScreen.y;
      if (dx * dx + dy * dy < MIN_STEP_PX * MIN_STEP_PX) continue;
      const p = screenToMap(camera, screen);
      drawing.points.push(p.x, p.y);
      drawing.lastScreen = screen;
      drawing.dirty = true;
    }
  }

  /** pointerup, pointercancel and lostpointercapture all commit what was drawn. */
  pointerUp(event: PointerEvent): void {
    if (this.#drawing?.pointerId !== event.pointerId) return;
    this.commit();
  }

  /** Escape while drawing: drop the stroke, commit nothing. */
  cancel(): boolean {
    if (!this.#drawing) return false;
    this.#drawing = null;
    this.#ctx.live.clear();
    this.#ctx.setLive(null);
    return true;
  }

  /** Called at most every 33 ms by the board: send the stroke so far, if it grew. */
  sendLive(): void {
    const drawing = this.#drawing;
    if (!drawing?.dirty) return;
    drawing.dirty = false;
    const epsilon = screenPxToMap(this.#ctx.camera.camera, LIVE_EPSILON_PX);
    const simplified = rdp(drawing.points, epsilon).slice(-LIVE_MAX_POINTS * 2);
    this.#ctx.setLive({
      id: drawing.id,
      colour: drawing.colour,
      width: drawing.width,
      points: simplified.map(round),
    });
  }

  commit(): void {
    const drawing = this.#drawing;
    if (!drawing) return;
    this.#drawing = null;
    commitStroke(this.#ctx.doc, {
      id: drawing.id,
      floor: TEST_FLOOR,
      colour: drawing.colour,
      width: drawing.width,
      points: drawing.points,
      epsilon: screenPxToMap(this.#ctx.camera.camera, 1),
      by: this.#ctx.identity().name,
    });
    // Same tick as the commit: the committed stroke replaces the live one in the next frame.
    this.#ctx.live.clear();
    this.#ctx.setLive(null);
  }
}
