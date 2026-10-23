import { ApiError, CreateRoomResponse, GetRoomResponse, type RoomId } from '@planted/schema';
import type { z } from 'zod';

/**
 * `code` is a server `ErrorCode`, or one of two client-side codes: `network` when the server
 * could not be reached, `invalid_response` when it answered with something the schema rejects.
 */
export class ApiClientError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ApiClientError';
  }
}

async function request<T>(schema: z.ZodType<T>, path: string, init?: RequestInit): Promise<T> {
  const baseUrl = import.meta.env.VITE_API_URL;
  if (!baseUrl) throw new ApiClientError('network', 0, 'VITE_API_URL is not configured');

  let res: Response;
  try {
    res = await fetch(new URL(path, baseUrl), {
      ...init,
      headers: { accept: 'application/json' },
    });
  } catch (cause) {
    throw new ApiClientError('network', 0, 'Could not reach the server', { cause });
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (cause) {
    throw new ApiClientError('invalid_response', res.status, 'Response was not JSON', { cause });
  }

  if (!res.ok) {
    const parsed = ApiError.safeParse(body);
    if (!parsed.success) {
      throw new ApiClientError('invalid_response', res.status, `Unexpected ${res.status} body`);
    }
    throw new ApiClientError(parsed.data.error.code, res.status, parsed.data.error.message);
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiClientError('invalid_response', res.status, 'Response did not match the schema', {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

export const api = {
  createRoom: () => request(CreateRoomResponse, '/rooms', { method: 'POST' }),
  getRoom: (roomId: RoomId) => request(GetRoomResponse, `/rooms/${roomId}`),
};
