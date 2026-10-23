import { RoomId } from '@planted/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError, api } from './api';

const roomId = RoomId.parse('0123456789abcdefABCDEF');
const createdAt = '2026-10-23T12:00:00.000Z';

function respond(status: number, body: string) {
  const fetchMock = vi.fn(async () => new Response(body, { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('api', () => {
  it('parses a valid createRoom response', async () => {
    const fetchMock = respond(201, JSON.stringify({ roomId, createdAt }));
    await expect(api.createRoom()).resolves.toEqual({ roomId, createdAt });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('http://api.test/rooms'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('parses a valid getRoom response', async () => {
    respond(200, JSON.stringify({ roomId, createdAt, mapId: null }));
    await expect(api.getRoom(roomId)).resolves.toEqual({ roomId, createdAt, mapId: null });
  });

  it('throws on a malformed JSON body', async () => {
    respond(200, '{"roomId":');
    await expect(api.getRoom(roomId)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('throws when a 2xx body does not match the schema', async () => {
    respond(201, JSON.stringify({ roomId: 'short', createdAt }));
    await expect(api.createRoom()).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('turns a 404 body into an ApiClientError with code not_found', async () => {
    respond(404, JSON.stringify({ error: { code: 'not_found', message: 'Room not found' } }));
    const error = await api.getRoom(roomId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({ code: 'not_found', status: 404, message: 'Room not found' });
  });

  it('reports a network failure as code network', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    await expect(api.createRoom()).rejects.toMatchObject({ code: 'network', status: 0 });
  });
});
