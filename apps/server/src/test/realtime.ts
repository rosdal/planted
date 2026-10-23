import { RoomClient, type SyncStatus, type WebSocketCtor } from '@planted/client';
import { decodeFrame, type Frame } from '@planted/protocol';
import type { RoomId } from '@planted/schema';
import { CreateRoomResponse } from '@planted/schema';
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

export async function listen(app: App, port = 0): Promise<string> {
  await app.listen({ port, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  return `ws://127.0.0.1:${address.port}`;
}

export async function createRoom(app: App): Promise<RoomId> {
  const res = await app.inject({ method: 'POST', url: '/rooms' });
  return CreateRoomResponse.parse(res.json()).roomId;
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

export function connectClient(url: string, roomId: string): TestClient {
  const sockets: RecordingWebSocket[] = [];
  class Impl extends RecordingWebSocket {
    constructor(url: string) {
      super(url);
      sockets.push(this);
    }
  }
  const client = new RoomClient({ url, roomId, WebSocketImpl: Impl as unknown as WebSocketCtor });
  return Object.assign(client, {
    socket: () => {
      const last = sockets.at(-1);
      if (!last) throw new Error('no socket yet');
      return last;
    },
  });
}

export async function waitForStatus(client: RoomClient, status: SyncStatus): Promise<void> {
  await until(() => client.status === status, { message: `status ${status}` });
}

export function peerIds(client: RoomClient): number[] {
  return [...client.awareness.getStates().keys()].filter((id) => id !== client.doc.clientID);
}
