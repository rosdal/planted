import { describe, expect, it } from 'vitest';
import { clampPan, fitCamera, MAX_SCALE, MIN_SCALE, zoomAt } from './camera';
import { screenToWorld, WORLD_SIZE } from './coords';

const viewport = { width: 1920, height: 1080 };

describe('camera', () => {
  it('keeps the world point under the cursor fixed while zooming', () => {
    const camera = { x: 100, y: 50, scale: 0.5 };
    const cursor = { x: 700, y: 400 };
    const before = screenToWorld(camera, cursor);
    const after = screenToWorld(zoomAt(camera, cursor, 1.7), cursor);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it('clamps scale to 0.2..8', () => {
    const camera = { x: 0, y: 0, scale: 1 };
    expect(zoomAt(camera, { x: 0, y: 0 }, 100).scale).toBe(MAX_SCALE);
    expect(zoomAt(camera, { x: 0, y: 0 }, 0.001).scale).toBe(MIN_SCALE);
  });

  it('fits the whole map, centred', () => {
    const camera = fitCamera(viewport);
    const size = WORLD_SIZE * camera.scale;
    expect(size).toBeLessThanOrEqual(viewport.height);
    expect(camera.x * 2 + size).toBeCloseTo(viewport.width);
    expect(camera.y * 2 + size).toBeCloseTo(viewport.height);
  });

  it('keeps at least 20% of the map on screen', () => {
    const scale = 0.25;
    const size = WORLD_SIZE * scale;
    const far = clampPan({ x: -1e6, y: 1e6, scale }, viewport);
    expect(far.x + size).toBeCloseTo(0.2 * size);
    expect(viewport.height - far.y).toBeCloseTo(0.2 * size);
  });

  it('when zoomed past the screen, keeps 20% of the screen covered', () => {
    const scale = 8;
    const far = clampPan({ x: 1e6, y: -1e7, scale }, viewport);
    expect(far.x).toBeCloseTo(viewport.width * 0.8);
    expect(far.y + WORLD_SIZE * scale).toBeCloseTo(viewport.height * 0.2);
  });
});
