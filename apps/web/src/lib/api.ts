import {
  ApiError,
  ClearRoomResponse,
  CreateRoomResponse,
  GetRoomResponse,
  type RoomId,
  RoomTokenResponse,
  RotateLinksResponse,
} from '@planted/schema';
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

type RequestOptions = { method?: 'GET' | 'POST'; token?: string; body?: unknown };

async function request<T>(
  schema: z.ZodType<T>,
  path: string,
  { method = 'GET', token, body: payload }: RequestOptions = {},
): Promise<T> {
  const baseUrl = import.meta.env.VITE_API_URL;
  if (!baseUrl) throw new ApiClientError('network', 0, 'VITE_API_URL is not configured');

  let res: Response;
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (payload !== undefined) headers['content-type'] = 'application/json';
    res = await fetch(new URL(path, baseUrl), {
      method,
      headers,
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
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
  createRoom: (mapId: string) =>
    request(CreateRoomResponse, '/rooms', { method: 'POST', body: { mapId } }),
  /** 403 `forbidden`: the key is wrong or its link was revoked. */
  roomToken: (roomId: RoomId, key: string) =>
    request(RoomTokenResponse, `/rooms/${roomId}/token`, { method: 'POST', body: { key } }),
  getRoom: (roomId: RoomId, token: string) =>
    request(GetRoomResponse, `/rooms/${roomId}`, { token }),
  rotateLinks: (roomId: RoomId, token: string) =>
    request(RotateLinksResponse, `/rooms/${roomId}/links/rotate`, { method: 'POST', token }),
  clearRoom: (roomId: RoomId, token: string) =>
    request(ClearRoomResponse, `/rooms/${roomId}/clear`, { method: 'POST', token }),
};
