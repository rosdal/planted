import { type Camera, type Point, screenToWorld, WORLD_SIZE } from './coords';

export const MIN_SCALE = 0.2;
export const MAX_SCALE = 8;
/** Share of the map (or of the viewport, when zoomed in past it) that must stay on screen. */
const KEEP_VISIBLE = 0.2;
/** Margin around the map when fitting it. */
const FIT_PADDING = 0.92;

export type Viewport = { width: number; height: number };

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** Keep at least 20% of the map on screen on both axes. */
export function clampPan(camera: Camera, viewport: Viewport): Camera {
  const mapSize = WORLD_SIZE * camera.scale;
  const clampAxis = (pos: number, size: number) => {
    const keep = KEEP_VISIBLE * Math.min(mapSize, size);
    return Math.min(size - keep, Math.max(keep - mapSize, pos));
  };
  return {
    scale: camera.scale,
    x: clampAxis(camera.x, viewport.width),
    y: clampAxis(camera.y, viewport.height),
  };
}

/** The whole map centred in the viewport. */
export function fitCamera(viewport: Viewport): Camera {
  const scale = clampScale(
    (Math.min(viewport.width, viewport.height) / WORLD_SIZE) * FIT_PADDING || MIN_SCALE,
  );
  return {
    scale,
    x: (viewport.width - WORLD_SIZE * scale) / 2,
    y: (viewport.height - WORLD_SIZE * scale) / 2,
  };
}

/** Zoom by `factor` around a screen point: the world point under it stays put. */
export function zoomAt(camera: Camera, screen: Point, factor: number): Camera {
  const scale = clampScale(camera.scale * factor);
  const world = screenToWorld(camera, screen);
  return { scale, x: screen.x - world.x * scale, y: screen.y - world.y * scale };
}

export function panBy(camera: Camera, dx: number, dy: number): Camera {
  return { ...camera, x: camera.x + dx, y: camera.y + dy };
}

/** Wheel steps: a mouse notch (deltaY 100) is about 14%; a pinch frame is finer. */
const WHEEL_ZOOM = 0.0015;
const PINCH_ZOOM = 0.01;
/** A trackpad gesture keeps panning for this long after it last moved both axes. */
const TRACKPAD_STICKY_MS = 300;
const DOUBLE_CLICK_MS = 350;

type Pan = { pointerId: number; last: Point };

/**
 * Local camera state plus its input: wheel zoom, trackpad pan and pinch, middle-drag and
 * Space+drag pan, middle double-click and `0` to fit. Holds no Pixi objects; the board reads
 * `camera` every frame and applies it to the world container.
 */
export class CameraController {
  camera: Camera = { x: 0, y: 0, scale: 1 };
  /** True while Space is held, so the pen knows not to start a stroke. */
  spaceHeld = false;

  #viewport: Viewport = { width: 1, height: 1 };
  #pan: Pan | null = null;
  #lastTrackpadAt = Number.NEGATIVE_INFINITY;
  #lastMiddleDownAt = Number.NEGATIVE_INFINITY;
  #fitted = false;
  readonly #element: HTMLElement;

  constructor(element: HTMLElement) {
    this.#element = element;
    element.addEventListener('wheel', this.#onWheel, { passive: false });
    window.addEventListener('keydown', this.#onKeyDown);
    window.addEventListener('keyup', this.#onKeyUp);
    window.addEventListener('blur', this.#onBlur);
  }

  get panning(): boolean {
    return this.#pan !== null;
  }

  get viewport(): Viewport {
    return this.#viewport;
  }

  /** The canvas changed size; the first call fits the map. */
  resize(viewport: Viewport): void {
    this.#viewport = viewport;
    this.camera = this.#fitted ? clampPan(this.camera, viewport) : fitCamera(viewport);
    this.#fitted = true;
  }

  fit(): void {
    this.camera = fitCamera(this.#viewport);
  }

  set(camera: Camera): void {
    this.camera = clampPan(camera, this.#viewport);
  }

  /** Returns true if the camera took this pointer (a pan), so no tool should see it. */
  pointerDown(event: PointerEvent, screen: Point): boolean {
    const middle = event.button === 1;
    if (middle) {
      event.preventDefault();
      if (event.timeStamp - this.#lastMiddleDownAt < DOUBLE_CLICK_MS) {
        this.#lastMiddleDownAt = Number.NEGATIVE_INFINITY;
        this.fit();
        return true;
      }
      this.#lastMiddleDownAt = event.timeStamp;
    }
    if (!middle && !(event.button === 0 && this.spaceHeld)) return false;
    this.#pan = { pointerId: event.pointerId, last: screen };
    this.#element.setPointerCapture(event.pointerId);
    return true;
  }

  pointerMove(event: PointerEvent, screen: Point): boolean {
    const pan = this.#pan;
    if (!pan || pan.pointerId !== event.pointerId) return false;
    this.set(panBy(this.camera, screen.x - pan.last.x, screen.y - pan.last.y));
    pan.last = screen;
    return true;
  }

  pointerUp(event: PointerEvent): boolean {
    if (!this.#pan || this.#pan.pointerId !== event.pointerId) return false;
    this.#pan = null;
    return true;
  }

  destroy(): void {
    this.#element.removeEventListener('wheel', this.#onWheel);
    window.removeEventListener('keydown', this.#onKeyDown);
    window.removeEventListener('keyup', this.#onKeyUp);
    window.removeEventListener('blur', this.#onBlur);
  }

  #onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const rect = this.#element.getBoundingClientRect();
    const screen = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    // Lines or pages (Firefox with a mouse) are coarse steps; normalise to pixels.
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
    const dx = event.deltaX * unit;
    const dy = event.deltaY * unit;

    if (event.ctrlKey) {
      // Trackpad pinch (and Ctrl+wheel): browsers report it as a ctrl wheel.
      this.set(zoomAt(this.camera, screen, Math.exp(-dy * PINCH_ZOOM)));
      return;
    }
    const trackpad =
      event.deltaMode === 0 &&
      ((dx !== 0 && dy !== 0) || event.timeStamp - this.#lastTrackpadAt < TRACKPAD_STICKY_MS);
    if (trackpad) {
      this.#lastTrackpadAt = event.timeStamp;
      this.set(panBy(this.camera, -dx, -dy));
      return;
    }
    this.set(zoomAt(this.camera, screen, Math.exp(-dy * WHEEL_ZOOM)));
  };

  #onKeyDown = (event: KeyboardEvent): void => {
    if (isTyping(event.target)) return;
    // Space only pans when nothing else has focus: on a button or radio it must still press it.
    const onBoard = event.target === document.body || event.target === this.#element;
    if (event.code === 'Space' && onBoard) {
      // Keep Space from scrolling the page or pressing a focused button.
      event.preventDefault();
      this.spaceHeld = true;
      this.#element.style.cursor = 'grab';
    } else if (event.key === '0' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      this.fit();
    }
  };

  #onKeyUp = (event: KeyboardEvent): void => {
    if (event.code === 'Space') {
      this.spaceHeld = false;
      this.#element.style.cursor = '';
    }
  };

  #onBlur = (): void => {
    this.spaceHeld = false;
    this.#element.style.cursor = '';
  };
}

/** Keyboard shortcuts stay out of the way while someone types in a field. */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}
