import { RoomId } from '@planted/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError, api } from './api';

const roomId = RoomId.parse('0123456789abcdefABCDEF');
const createdAt = '2026-10-23T12:00:00.000Z';
const editKey = 'e'.repeat(43);
const viewKey = 'v'.repeat(43);

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
    const fetchMock = respond(201, JSON.stringify({ roomId, createdAt, editKey, viewKey }));
    await expect(api.createRoom()).resolves.toEqual({ roomId, createdAt, editKey, viewKey });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('http://api.test/rooms'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('parses a valid getRoom response and sends the room token as a bearer header', async () => {
    const fetchMock = respond(200, JSON.stringify({ roomId, createdAt, mapId: null }));
    await expect(api.getRoom(roomId, 'tok')).resolves.toEqual({ roomId, createdAt, mapId: null });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer tok' }),
      }),
    );
  });

  it('posts the key as JSON for a room token', async () => {
    const expiresAt = '2026-10-23T12:05:00.000Z';
    const fetchMock = respond(200, JSON.stringify({ token: 't', role: 'view', expiresAt }));
    await expect(api.roomToken(roomId, viewKey)).resolves.toEqual({
      token: 't',
      role: 'view',
      expiresAt,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL(`http://api.test/rooms/${roomId}/token`),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ key: viewKey }),
        headers: expect.objectContaining({ 'content-type': 'application/json' }),
      }),
    );
  });

  it('turns a 403 into code forbidden, which the room page shows as a revoked link', async () => {
    respond(
      403,
      JSON.stringify({ error: { code: 'forbidden', message: 'This link is not valid' } }),
    );
    await expect(api.roomToken(roomId, editKey)).rejects.toMatchObject({
      code: 'forbidden',
      status: 403,
    });
  });

  it('throws on a malformed JSON body', async () => {
    respond(200, '{"roomId":');
    await expect(api.getRoom(roomId, 'tok')).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('throws when a 2xx body does not match the schema', async () => {
    respond(201, JSON.stringify({ roomId: 'short', createdAt }));
    await expect(api.createRoom()).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('turns a 404 body into an ApiClientError with code not_found', async () => {
    respond(404, JSON.stringify({ error: { code: 'not_found', message: 'Room not found' } }));
    const error = await api.getRoom(roomId, 'tok').catch((e: unknown) => e);
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
