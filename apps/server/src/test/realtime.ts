import {
  cachedTokens,
  LinkRevokedError,
  RoomClient,
  type RoomClientOptions,
  type SyncStatus,
  type WebSocketCtor,
} from '@planted/client';
import { decodeFrame, type Frame } from '@planted/protocol';
import { CreateRoomResponse, type RoomId, RoomTokenResponse } from '@planted/schema';
import { EvilClient } from '@planted/scripts/evil-client';
import WebSocket from 'ws';
import type { App } from '../app';

/** `ws` that records every frame it receives, for asserting on the wire. */
export class RecordingWebSocket extends WebSocket {
  readonly received: Frame[] = [];

  constructor(url: string) {
    super(url);
    // The client sets binaryType to 'arraybuffer'; a Uint8Array over either kind works.
    this.on('message', (data: ArrayBuffer | Buffer) => {
      this.received.push(decodeFrame(new Uint8Array(data)));
    });
  }
}

export type TestClient = RoomClient & {
  /** The client's current (or last) socket. */
  socket: () => RecordingWebSocket;
};

export type TestRoom = { roomId: RoomId; editKey: string; viewKey: string };

export async function listen(app: App, port = 0): Promise<string> {
  await app.listen({ port, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  return `ws://127.0.0.1:${address.port}`;
}

export async function createRoom(app: App): Promise<TestRoom> {
  const res = await app.inject({ method: 'POST', url: '/rooms' });
  const { roomId, editKey, viewKey } = CreateRoomResponse.parse(res.json());
  return { roomId, editKey, viewKey };
}

/** A token straight from the route; 403 throws `LinkRevokedError`, like the real client's. */
export async function issueToken(
  app: () => App,
  roomId: string,
  key: string,
): Promise<{ token: string; expiresAt: string }> {
  const res = await app().inject({
    method: 'POST',
    url: `/rooms/${roomId}/token`,
    payload: { key },
  });
  if (res.statusCode === 403) throw new LinkRevokedError();
  if (res.statusCode !== 200) throw new Error(`token route answered ${res.statusCode}`);
  return RoomTokenResponse.parse(res.json());
}

/**
 * One token cache per key, shared by every client using it, so a test with 51 sockets stays
 * under the token route's 30 a minute. `app` is a getter because restart tests swap the app.
 */
export function tokenSource(app: () => App) {
  const caches = new Map<string, ReturnType<typeof cachedTokens>>();
  return (roomId: string, key: string) => {
    const id = `${roomId}:${key}`;
    let cache = caches.get(id);
    if (!cache) {
      cache = cachedTokens(() => issueToken(app, roomId, key));
      caches.set(id, cache);
    }
    return cache;
  };
}

export function connectClient(
  url: string,
  roomId: string,
  getToken: RoomClientOptions['getToken'],
): TestClient {
  const sockets: RecordingWebSocket[] = [];
  class Impl extends RecordingWebSocket {
    constructor(url: string) {
      super(url);
      sockets.push(this);
    }
  }
  const client = new RoomClient({
    url,
    roomId,
    getToken,
    WebSocketImpl: Impl as unknown as WebSocketCtor,
    dev: true,
  });
  return Object.assign(client, {
    socket: () => {
      const last = sockets.at(-1);
      if (!last) throw new Error('no socket yet');
      return last;
    },
  });
}

/** An `EvilClient` that has said hello with a token for `key` and been welcomed. */
export async function joinEvil(url: string, roomId: string, token: string): Promise<EvilClient> {
  const evil = await EvilClient.connect(url, roomId);
  await evil.join(token);
  return evil;
}

/** Polls with `setImmediate`, which the realtime tests never fake. */
export async function until(
  condition: () => boolean,
  { timeoutMs = 5000, message = 'condition' } = {},
): Promise<void> {
  const start = performance.now();
  while (!condition()) {
    if (performance.now() - start > timeoutMs) throw new Error(`timed out waiting for ${message}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export async function waitForStatus(client: RoomClient, status: SyncStatus): Promise<void> {
  await until(() => client.status === status, { message: `status ${status}` });
}

export function peerIds(client: RoomClient): number[] {
  return [...client.awareness.getStates().keys()].filter((id) => id !== client.doc.clientID);
}
