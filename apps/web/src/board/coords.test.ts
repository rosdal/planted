import { describe, expect, it } from 'vitest';
import {
  type Camera,
  mapToScreen,
  mapToWorld,
  screenToMap,
  screenToWorld,
  WORLD_SIZE,
  worldToMap,
  worldToScreen,
} from './coords';

const cameras: Camera[] = [0.2, 0.37, 1, 2.5, 8].map((scale, i) => ({
  scale,
  x: -300 + i * 211,
  y: 120 - i * 97,
}));
const points = [
  { x: 0, y: 0 },
  { x: 0.25, y: 0.75 },
  { x: 1, y: 1 },
  { x: -0.1, y: 1.3 },
];

describe('coords', () => {
  it('maps the unit square onto the world', () => {
    expect(mapToWorld({ x: 1, y: 0.5 })).toEqual({ x: WORLD_SIZE, y: WORLD_SIZE / 2 });
  });

  it('round-trips map and world', () => {
    for (const p of points) {
      const back = worldToMap(mapToWorld(p));
      expect(back.x).toBeCloseTo(p.x, 12);
      expect(back.y).toBeCloseTo(p.y, 12);
    }
  });

  it.each(cameras)('round-trips world and screen at scale $scale', (camera) => {
    for (const p of points.map(mapToWorld)) {
      const viaScreen = screenToWorld(camera, worldToScreen(camera, p));
      expect(viaScreen.x).toBeCloseTo(p.x, 9);
      expect(viaScreen.y).toBeCloseTo(p.y, 9);
      const screen = { x: p.x / 7, y: p.y / 3 };
      const viaWorld = worldToScreen(camera, screenToWorld(camera, screen));
      expect(viaWorld.x).toBeCloseTo(screen.x, 9);
      expect(viaWorld.y).toBeCloseTo(screen.y, 9);
    }
  });

  it.each(cameras)('round-trips map and screen at scale $scale', (camera) => {
    for (const p of points) {
      const back = screenToMap(camera, mapToScreen(camera, p));
      expect(back.x).toBeCloseTo(p.x, 12);
      expect(back.y).toBeCloseTo(p.y, 12);
    }
  });

  it('puts the world origin at the camera offset', () => {
    expect(worldToScreen({ x: 40, y: -8, scale: 3 }, { x: 0, y: 0 })).toEqual({ x: 40, y: -8 });
  });
});
