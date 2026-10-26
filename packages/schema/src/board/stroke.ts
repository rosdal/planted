import { z } from 'zod';

/** Most points one stroke may hold; the pen simplifies long strokes well below this. */
export const MAX_STROKE_POINTS = 4096;

/**
 * A committed pen stroke, one nested `Y.Map` in `doc.getMap('objects')`. Coordinates are map
 * space (0..1 per floor), so a stroke survives higher-resolution map art.
 */
export const StrokeObject = z.object({
  kind: z.literal('stroke'),
  /** A floor id of the room's map; the server rejects any other. */
  floor: z.string().min(1).max(64),
  /** null until phases arrive in 0.6. */
  phase: z.string().nullable(),
  colour: z.string().regex(/^#[0-9a-f]{6}$/i),
  /** Map units, so it scales with zoom. */
  width: z.number().min(0.0002).max(0.02),
  /** Float32 x, y pairs in map space, as raw bytes. */
  points: z
    .instanceof(Uint8Array)
    .refine((b) => b.byteLength > 0 && b.byteLength % 8 === 0, 'whole x, y pairs')
    .refine((b) => b.byteLength <= MAX_STROKE_POINTS * 8, `at most ${MAX_STROKE_POINTS} points`),
  /** Awareness user name at the time. */
  by: z.string(),
  /** `Date.now()` at commit. */
  at: z.number(),
});
export type StrokeObject = z.infer<typeof StrokeObject>;

/** The one floor of rooms created before 0.5, which have no map. */
export const TEST_FLOOR = 'test-1';
