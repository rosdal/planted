import { z } from 'zod';
import { StrokeObject } from './stroke';

/**
 * Every kind of board object, discriminated on `kind`. The server parses each object a client
 * touched against this after applying its update, and deletes any that fail. More kinds join in
 * 0.6.
 */
export const BoardObject = z.discriminatedUnion('kind', [StrokeObject]);
export type BoardObject = z.infer<typeof BoardObject>;
