import {
  AwarenessType,
  awarenessFrame,
  Channel,
  decodeFrame,
  ProtocolError,
  sync1Frame,
  sync2Frame,
  updateFrame,
  YjsType,
} from '@planted/protocol';
import { Awareness, applyAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { backoffDelay, STABLE_AFTER_MS } from './backoff';

/** Close codes the server uses; see apps/server/src/realtime/connection.ts. */
export const CloseCode = {
  Normal: 1000,
  GoingAway: 1001,
  BadUpdate: 4400,
  RoomNotFound: 4404,
} as const;

export type SyncStatus = 'connecting' | 'syncing' | 'synced' | 'offline';
export type StopReason = 'room_not_found' | 'protocol_error' | 'destroyed';

/** The slice of the WebSocket API the client needs; both the browser's and `ws` fit. */
export interface WebSocketLike {
  binaryType: string;
  readonly readyState: number;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}
export type WebSocketCtor = new (url: string) => WebSocketLike;

export type RoomClientOptions = {
  /** Server origin as a ws(s) URL, e.g. `ws://localhost:3000`. */
  url: string;
  roomId: string;
  WebSocketImpl?: WebSocketCtor;
  /** Injected for tests; defaults to `Math.random`. */
  random?: () => number;
};

export type RoomClientStats = {
  framesSent: number;
  framesReceived: number;
  bytesSent: number;
  bytesReceived: number;
  /** Frames this client could not decode: a newer server's channel, or a malformed frame. */
  framesRejected: number;
  /** sync-1 sent → sync-2 received, from the last handshake or `probe()`. */
  lastRttMs: number | null;
};

type Events = {
  status: (status: SyncStatus) => void;
  stop: (reason: StopReason) => void;
};

const OPEN = 1;

/**
 * One room connection. Owns a `Y.Doc` and an `Awareness` for its whole life, so edits made while
 * offline stay in the doc and merge on the next handshake. No DOM APIs: the bots run it in Node.
 */
export class RoomClient {
  readonly doc = new Y.Doc();
  readonly awareness = new Awareness(this.doc);
  readonly stats: RoomClientStats = {
    framesSent: 0,
    framesReceived: 0,
    bytesSent: 0,
    bytesReceived: 0,
    framesRejected: 0,
    lastRttMs: null,
  };

  #status: SyncStatus = 'connecting';
  #stopReason: StopReason | null = null;
  #attempt = 0;
  #socket: WebSocketLike | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #stableTimer: ReturnType<typeof setTimeout> | null = null;
  #wantOnline = true;
  #gotSync2 = false;
  #sentSync2 = false;
  #pendingProbes: number[] = [];
  #listeners: { [K in keyof Events]: Set<Events[K]> } = { status: new Set(), stop: new Set() };

  readonly #url: string;
  readonly #WebSocketImpl: WebSocketCtor;
  readonly #random: () => number;

  constructor({ url, roomId, WebSocketImpl, random = Math.random }: RoomClientOptions) {
    this.#url = `${url.replace(/\/$/, '')}/rooms/${encodeURIComponent(roomId)}/ws`;
    const impl = WebSocketImpl ?? (globalThis.WebSocket as unknown as WebSocketCtor | undefined);
    if (!impl) throw new Error('No WebSocket implementation; pass WebSocketImpl');
    this.#WebSocketImpl = impl;
    this.#random = random;

    this.doc.on('update', this.#onDocUpdate);
    this.awareness.on('update', this.#onAwarenessUpdate);
    this.#connect();
  }

  get status(): SyncStatus {
    return this.#status;
  }

  get stopReason(): StopReason | null {
    return this.#stopReason;
  }

  /** Reconnect attempts since the last stable connection. */
  get attempt(): number {
    return this.#attempt;
  }

  /** False while the user has asked to stay offline (`setOnline(false)`). */
  get wantsOnline(): boolean {
    return this.#wantOnline;
  }

  on<K extends keyof Events>(event: K, listener: Events[K]): () => void {
    this.#listeners[event].add(listener);
    return () => this.#listeners[event].delete(listener);
  }

  /** Skip the backoff wait, e.g. on the browser's `online` or a tab becoming visible. */
  wake(): void {
    if (this.#stopReason || !this.#wantOnline || this.#socket) return;
    this.#clearReconnect();
    this.#connect();
  }

  /** `false` closes the socket and blocks reconnects; local edits keep accumulating. */
  setOnline(online: boolean): void {
    this.#wantOnline = online;
    if (online) {
      this.#attempt = 0;
      this.wake();
      return;
    }
    this.#clearReconnect();
    this.#socket?.close(CloseCode.Normal, 'offline');
    this.#dropSocket();
  }

  /** Send a sync-1 to measure the round trip; the answer updates `stats.lastRttMs`. */
  probe(): void {
    if (this.#socket?.readyState !== OPEN) return;
    this.#pendingProbes.push(performance.now());
    this.#send(sync1Frame(this.doc));
  }

  destroy(): void {
    if (this.#stopReason === 'destroyed') return;
    // Clear presence while the socket is still open, so the others see us leave instantly.
    this.awareness.setLocalState(null);
    this.#socket?.close(CloseCode.Normal, 'destroyed');
    this.#dropSocket();
    this.#stop('destroyed');
    this.doc.off('update', this.#onDocUpdate);
    this.awareness.off('update', this.#onAwarenessUpdate);
    this.awareness.destroy();
    this.doc.destroy();
    for (const set of Object.values(this.#listeners)) set.clear();
  }

  #connect(): void {
    this.#setStatus('connecting');
    const socket = new this.#WebSocketImpl(this.#url);
    socket.binaryType = 'arraybuffer';
    this.#socket = socket;
    this.#gotSync2 = false;
    this.#sentSync2 = false;
    this.#pendingProbes = [];

    socket.onopen = () => {
      if (this.#socket !== socket) return;
      this.#setStatus('syncing');
      this.#stableTimer = setTimeout(() => {
        this.#attempt = 0;
      }, STABLE_AFTER_MS);
      this.#pendingProbes.push(performance.now());
      this.#send(sync1Frame(this.doc));
      // Bump our awareness clock: the server kept the clock we had before the drop, and it
      // ignores a state that doesn't move the clock forward.
      const local = this.awareness.getLocalState();
      if (local !== null) this.awareness.setLocalState(local);
    };
    socket.onmessage = (event) => {
      if (this.#socket !== socket) return;
      if (!(event.data instanceof ArrayBuffer)) return;
      this.#onFrame(new Uint8Array(event.data));
    };
    socket.onclose = (event) => {
      if (this.#socket !== socket) return;
      this.#dropSocket();
      if (event.code === CloseCode.RoomNotFound) this.#stop('room_not_found');
      else if (event.code === CloseCode.BadUpdate) this.#stop('protocol_error');
      else this.#scheduleReconnect();
    };
    // An error is always followed by close, which does the work.
    socket.onerror = () => {};
  }

  #onFrame(bytes: Uint8Array): void {
    this.stats.framesReceived++;
    this.stats.bytesReceived += bytes.byteLength;
    let frame: ReturnType<typeof decodeFrame>;
    try {
      frame = decodeFrame(bytes);
    } catch (err) {
      // Skip it rather than drop the connection: it may be a channel from a newer server.
      // Counted, so a real bug (like an over-limit frame) shows up on the debug page.
      if (err instanceof ProtocolError) {
        this.stats.framesRejected++;
        return;
      }
      throw err;
    }
    if (frame.channel === Channel.Awareness && frame.type === AwarenessType.Update) {
      applyAwarenessUpdate(this.awareness, frame.payload, this);
      return;
    }
    switch (frame.type) {
      case YjsType.Sync1:
        this.#send(sync2Frame(this.doc, frame.payload));
        this.#sentSync2 = true;
        break;
      case YjsType.Sync2: {
        Y.applyUpdate(this.doc, frame.payload, this);
        const sentAt = this.#pendingProbes.shift();
        if (sentAt !== undefined) this.stats.lastRttMs = performance.now() - sentAt;
        this.#gotSync2 = true;
        break;
      }
      case YjsType.Update:
        Y.applyUpdate(this.doc, frame.payload, this);
        break;
    }
    if (this.#status === 'syncing' && this.#gotSync2 && this.#sentSync2) {
      this.#setStatus('synced');
    }
  }

  #onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    // While offline the edit just stays in the doc; the next handshake carries it.
    if (origin !== this) this.#send(updateFrame(update));
  };

  #onAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin === this) return;
    this.#send(awarenessFrame(this.awareness, [...added, ...updated, ...removed]));
  };

  #send(bytes: Uint8Array): void {
    const socket = this.#socket;
    if (socket?.readyState !== OPEN) return;
    socket.send(bytes);
    this.stats.framesSent++;
    this.stats.bytesSent += bytes.byteLength;
  }

  #dropSocket(): void {
    const socket = this.#socket;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      this.#socket = null;
    }
    if (this.#stableTimer) clearTimeout(this.#stableTimer);
    this.#stableTimer = null;
    this.#forgetPeers();
    this.#setStatus('offline');
  }

  /**
   * Offline, nobody else's presence is current. Drop their states and clocks outright (not via
   * `removeAwarenessStates`, which keeps the clock) so the server's resend after reconnect,
   * which carries the same clocks, is accepted.
   */
  #forgetPeers(): void {
    const removed = [...this.awareness.getStates().keys()].filter(
      (id) => id !== this.awareness.clientID,
    );
    if (removed.length === 0) return;
    for (const id of removed) {
      this.awareness.states.delete(id);
      this.awareness.meta.delete(id);
    }
    const change = { added: [], updated: [], removed };
    this.awareness.emit('change', [change, this]);
    this.awareness.emit('update', [change, this]);
  }

  #scheduleReconnect(): void {
    if (this.#stopReason || !this.#wantOnline) return;
    const delay = backoffDelay(this.#attempt, this.#random);
    this.#attempt++;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, delay);
  }

  #clearReconnect(): void {
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
  }

  #stop(reason: StopReason): void {
    this.#clearReconnect();
    this.#stopReason = reason;
    for (const listener of this.#listeners.stop) listener(reason);
  }

  #setStatus(status: SyncStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    for (const listener of this.#listeners.status) listener(status);
  }
}
