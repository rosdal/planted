import { z } from 'zod';

export const ERROR_CODES = ['not_found', 'bad_request', 'rate_limited', 'internal'] as const;
export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;

/**
 * Every non-2xx response body. `code` stays a plain string so a client built against an
 * older schema still parses codes added later.
 */
export const ApiError = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
export type ApiError = z.infer<typeof ApiError>;
