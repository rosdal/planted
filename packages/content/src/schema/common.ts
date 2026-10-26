import { z } from 'zod';

/** A point in map space: 0..1 on both axes, per floor, like everything on the board. */
export const Vec2 = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]);
export type Vec2 = z.infer<typeof Vec2>;

/** Lowercase ids: `clubhouse`, `2f`, `breach-charge`. */
export const Slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lowercase words joined by -');

/** Season tag, e.g. `y11s3`. */
export const SeasonTag = z.string().regex(/^y\d+s\d+$/, 'a season tag like y11s3');

/** Content version: season tag plus build number, e.g. `y11s3.1`. */
export const ContentVersion = z.string().regex(/^y\d+s\d+\.\d+$/, 'a version like y11s3.1');
export type ContentVersion = z.infer<typeof ContentVersion>;

export const Side = z.enum(['attack', 'defence']);
export type Side = z.infer<typeof Side>;
