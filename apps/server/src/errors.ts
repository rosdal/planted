import type { ApiError, ErrorCode } from '@planted/schema';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

function body(code: ErrorCode, message: string): ApiError {
  return { error: { code, message } };
}

/** Every error leaves as `ApiError`; unknown errors are logged with their stack, never returned. */
export function errorHandler(
  error: FastifyError | AppError,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (error instanceof AppError) {
    return reply.status(error.status).send(body(error.code, error.message));
  }
  if (hasZodFastifySchemaValidationErrors(error)) {
    return reply.status(400).send(body('bad_request', error.message));
  }
  // Fastify's own client errors: malformed JSON, wrong content type, body too large.
  const status = error.statusCode ?? 500;
  if (status >= 400 && status < 500) {
    const code: ErrorCode = status === 429 ? 'rate_limited' : 'bad_request';
    return reply.status(status).send(body(code, error.message));
  }
  request.log.error({ err: error }, 'unhandled error');
  return reply.status(500).send(body('internal', 'Internal server error'));
}

export function notFoundHandler(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply
    .status(404)
    .send(body('not_found', `Route ${request.method} ${request.url} not found`));
}
