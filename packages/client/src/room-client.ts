import {
  AwarenessType,
  awarenessFrame,
  Channel,
  CloseCode,
  type ControlMessage,
  controlFrame,
  decodeControl,
  decodeFrame,
  ProtocolError,
  sync1Frame,
  sync2Frame,
  updateFrame,
  YjsType,
} from '@planted/protocol';
import { PROTOCOL_VERSION, type RoomLimits, type RoomRole } from '@planted/schema';
import { Awareness, applyAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { backoffDelay, STABLE_AFTER_MS } from './backoff';

export { CloseCode };

/** App-level ping interval; two unanswered pings and the client reconnects. */
export const PING_INTERVAL_MS = 15_000;
export const MISSED_PONGS_BEFORE_RECONNECT = 2;
/** After a 4429 the client waits at least this long before trying again. */
export const RATE_LIMITED_BACKOFF_MS = 30_000;

export type SyncStatus = 'connecting' | 'syncing' | 'synced' | 'offline';
export type StopReason =
  | 'room_not_found'
  | 'link_revoked'
  | 'upgrade_required'
  | 'forbidden'
  | 'protocol_error'
  | 'destroyed';

/**
 * Something to tell the user without stopping: `reset` after the board was cleared, and the
 * server's non-fatal errors (`object_limit`, `doc_limit`) or a 4413 / 4429 close.
 */
export type Notice = { code: string; message: string };

/** Throw this from `getToken` when the server refused the key (403): the link was revoked. */
export class LinkRevokedError extends Error {
  constructor(message = 'This link was revoked') {
    super(message);
    this.name = 'LinkRevokedError';
  }
}

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

/**
 * `connect` before an ordinary (re)connect; `refresh` after the server rejected the last token
 * with 4401, so a cache must not hand back the same one.
 */
export type TokenReason = 'connect' | 'refresh';

export type RoomClientOptions = {
  /** Server origin as a ws(s) URL, e.g. `ws://localhost:3000`. */
  url: string;
  roomId: string;
  /** A room token for every `hello`; called before each connect, so it is never stale. */
  getToken: (reason: TokenReason) => Promise<string>;
  /** Shown in server logs. */
  clientName?: string;
  WebSocketImpl?: WebSocketCtor;
  /** Injected for tests; defaults to `Math.random`. */
  random?: () => number;
  /** Throw when a viewer tries to send an update, instead of dropping it silently. */
  dev?: boolean;
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
  /** The doc and awareness were replaced (epoch change): rebind anything holding them. */
  reset: () => void;
  notice: (notice: Notice) => void;
  role: (role: RoomRole) => void;
};

const OPEN = 1;

/**
 * One room connection. Owns a `Y.Doc` and an `Awareness`, so edits made while offline stay in
 * the doc and merge on the next handshake. The only time they're replaced is an epoch change:
 * the room's doc was replaced on the server, and merging the old one back would resurrect what
 * was cleared. No DOM APIs: the bots run it in Node.
 *
 * Handshake: fetch a token → open → `hello` → `welcome` (role, epoch, limits) → sync-1/sync-2.
 */
export class RoomClient {
  readonly stats: RoomClientStats = {
    framesSent: 0,
    framesReceived: 0,
    bytesSent: 0,
    bytesReceived: 0,
    framesRejected: 0,
    lastRttMs: null,
  };

  #doc = new Y.Doc();
  #awareness = new Awareness(this.#doc);
  #status: SyncStatus = 'connecting';
  #stopReason: StopReason | null = null;
  #attempt = 0;
  #socket: WebSocketLike | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #stableTimer: ReturnType<typeof setTimeout> | null = null;
  #pingTimer: ReturnType<typeof setInterval> | null = null;
  #missedPongs = 0;
  #wantOnline = true;
  /** A token request is in flight; the socket opens when it lands. */
  #fetchingToken = false;
  #welcomed = false;
  #gotSync2 = false;
  #sentSync2 = false;
  #pendingProbes: number[] = [];
  #nextSeq = 1;
  /** The last close was a 4401 and no `welcome` came since: a second one means revoked. */
  #tokenRejected = false;
  #role: RoomRole | null = null;
  #limits: RoomLimits | null = null;
  /** The epoch this doc belongs to; null until the first `welcome`. */
  #epoch: number | null = null;
  #lastError: Notice | null = null;
  #generation = 0;
  #listeners: { [K in keyof Events]: Set<Events[K]> } = {
    status: new Set(),
    stop: new Set(),
    reset: new Set(),
    notice: new Set(),
    role: new Set(),
  };

  readonly #url: string;
  readonly #getToken: (reason: TokenReason) => Promise<string>;
  readonly #clientName: string;
  readonly #WebSocketImpl: WebSocketCtor;
  readonly #random: () => number;
  readonly #dev: boolean;

  constructor({
    url,
    roomId,
    getToken,
    clientName = 'planted',
    WebSocketImpl,
    random = Math.random,
    dev = false,
  }: RoomClientOptions) {
    this.#url = `${url.replace(/\/$/, '')}/rooms/${encodeURIComponent(roomId)}/ws`;
    const impl = WebSocketImpl ?? (globalThis.WebSocket as unknown as WebSocketCtor | undefined);
    if (!impl) throw new Error('No WebSocket implementation; pass WebSocketImpl');
    this.#WebSocketImpl = impl;
    this.#getToken = getToken;
    this.#clientName = clientName;
    this.#random = random;
    this.#dev = dev;

    this.#bindDoc();
    void this.#connect('connect');
  }

  /** Replaced on an epoch change; listen for `reset` to rebind. */
  get doc(): Y.Doc {
    return this.#doc;
  }

  get awareness(): Awareness {
    return this.#awareness;
  }

  /** Bumps on every `reset`, for keying UI on the current doc. */
  get generation(): number {
    return this.#generation;
  }

  get status(): SyncStatus {
    return this.#status;
  }

  get stopReason(): StopReason | null {
    return this.#stopReason;
  }

  /** From the last `welcome`; null before the first. */
  get role(): RoomRole | null {
    return this.#role;
  }

  get limits(): RoomLimits | null {
    return this.#limits;
  }

  get epoch(): number | null {
    return this.#epoch;
  }

  /** The last `error` frame the server sent, fatal or not. */
  get lastError(): Notice | null {
    return this.#lastError;
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
    if (this.#stopReason || !this.#wantOnline || this.#socket || this.#fetchingToken) return;
    this.#clearReconnect();
    void this.#connect('connect');
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
    if (this.#socket?.readyState !== OPEN || !this.#welcomed) return;
    this.#pendingProbes.push(performance.now());
    this.#send(sync1Frame(this.#doc));
  }

  destroy(): void {
    if (this.#stopReason === 'destroyed') return;
    // Clear presence while the socket is still open, so the others see us leave instantly.
    this.#awareness.setLocalState(null);
    this.#socket?.close(CloseCode.Normal, 'destroyed');
    this.#dropSocket();
    this.#stop('destroyed');
    this.#unbindDoc();
    this.#awareness.destroy();
    this.#doc.destroy();
    for (const set of Object.values(this.#listeners)) set.clear();
  }

  #bindDoc(): void {
    this.#doc.on('update', this.#onDocUpdate);
    this.#awareness.on('update', this.#onAwarenessUpdate);
  }

  #unbindDoc(): void {
    this.#doc.off('update', this.#onDocUpdate);
    this.#awareness.off('update', this.#onAwarenessUpdate);
  }

  /** A fresh doc and awareness, keeping only our own presence (name, colour). */
  #resetDoc(): void {
    const local = this.#awareness.getLocalState();
    this.#unbindDoc();
    this.#awareness.destroy();
    this.#doc.destroy();
    this.#doc = new Y.Doc();
    this.#awareness = new Awareness(this.#doc);
    if (local) this.#awareness.setLocalState({ ...local, cursor: null, live: null });
    this.#bindDoc();
    this.#generation++;
    this.#emit('reset');
  }

  async #connect(reason: TokenReason): Promise<void> {
    this.#setStatus('connecting');
    let token: string;
    this.#fetchingToken = true;
    try {
      token = await this.#getToken(reason);
    } catch (err) {
      this.#fetchingToken = false;
      if (this.#stopReason || !this.#wantOnline) return;
      if (err instanceof LinkRevokedError) this.#stop('link_revoked');
      else this.#scheduleReconnect();
      return;
    }
    this.#fetchingToken = false;
    // Destroyed, taken offline, or woken twice while the token was on its way.
    if (this.#stopReason || !this.#wantOnline || this.#socket) return;

    const socket = new this.#WebSocketImpl(this.#url);
    socket.binaryType = 'arraybuffer';
    this.#socket = socket;
    this.#welcomed = false;
    this.#gotSync2 = false;
    this.#sentSync2 = false;
    this.#pendingProbes = [];
    this.#missedPongs = 0;

    socket.onopen = () => {
      if (this.#socket !== socket) return;
      this.#setStatus('syncing');
      this.#sendControl({
        kind: 'hello',
        seq: this.#nextSeq++,
        body: { protocol: PROTOCOL_VERSION, token, clientName: this.#clientName },
      });
    };
    socket.onmessage = (event) => {
      if (this.#socket !== socket) return;
      if (!(event.data instanceof ArrayBuffer)) return;
      this.#onFrame(new Uint8Array(event.data));
    };
    socket.onclose = (event) => {
      if (this.#socket !== socket) return;
      this.#dropSocket();
      this.#onClose(event.code);
    };
    // An error is always followed by close, which does the work.
    socket.onerror = () => {};
  }

  #onClose(code: number): void {
    const rejectedBefore = this.#tokenRejected;
    this.#tokenRejected = code === CloseCode.BadToken;
    switch (code) {
      case CloseCode.RoomNotFound:
        this.#stop('room_not_found');
        return;
      case CloseCode.ProtocolTooOld:
        this.#stop('upgrade_required');
        return;
      case CloseCode.Forbidden:
        this.#stop('forbidden');
        return;
      case CloseCode.BadFrame:
        this.#stop('protocol_error');
        return;
      case CloseCode.BadToken:
        // Once with a fresh token; a second 4401 in a row means the link itself is gone.
        if (rejectedBefore) {
          this.#stop('link_revoked');
          return;
        }
        if (this.#wantOnline) void this.#connect('refresh');
        return;
      case CloseCode.EpochChanged:
        this.#resetDoc();
        this.#notice({ code: 'reset', message: 'Board was reset' });
        if (this.#wantOnline) void this.#connect('connect');
        return;
      case CloseCode.RateLimited:
        this.#notice({ code: 'rate_limited', message: 'Too much traffic, reconnecting soon' });
        this.#scheduleReconnect(RATE_LIMITED_BACKOFF_MS);
        return;
      case CloseCode.DocLimit:
        this.#notice({ code: 'doc_limit', message: 'This board is full' });
        this.#scheduleReconnect();
        return;
      default:
        this.#scheduleReconnect();
        return;
    }
  }

  #onFrame(bytes: Uint8Array): void {
    this.stats.framesReceived++;
    this.stats.bytesReceived += bytes.byteLength;
    let frame: ReturnType<typeof decodeFrame>;
    let control: ControlMessage | null = null;
    try {
      frame = decodeFrame(bytes);
      if (frame.channel === Channel.Control) control = decodeControl(frame);
    } catch (err) {
      // Skip it rather than drop the connection: it may be a channel from a newer server.
      // Counted, so a real bug (like an over-limit frame) shows up on the debug page.
      if (err instanceof ProtocolError) {
        this.stats.framesRejected++;
        return;
      }
      throw err;
    }
    if (control) {
      this.#onControl(control);
      return;
    }
    if (frame.channel === Channel.App) return;
    if (!this.#welcomed) {
      this.stats.framesRejected++;
      return;
    }
    if (frame.channel === Channel.Awareness) {
      if (frame.type === AwarenessType.Update) {
        applyAwarenessUpdate(this.#awareness, frame.payload, this);
      }
      return;
    }
    if (frame.channel !== Channel.Yjs) return;
    switch (frame.type) {
      case YjsType.Sync1:
        // The server never asks a viewer for its state; answering would be an update.
        if (this.#role !== 'edit') break;
        this.#send(sync2Frame(this.#doc, frame.payload));
        this.#sentSync2 = true;
        break;
      case YjsType.Sync2: {
        Y.applyUpdate(this.#doc, frame.payload, this);
        const sentAt = this.#pendingProbes.shift();
        if (sentAt !== undefined) this.stats.lastRttMs = performance.now() - sentAt;
        this.#gotSync2 = true;
        break;
      }
      case YjsType.Update:
        Y.applyUpdate(this.#doc, frame.payload, this);
        break;
    }
    const sentEnough = this.#role === 'view' || this.#sentSync2;
    if (this.#status === 'syncing' && this.#gotSync2 && sentEnough) this.#setStatus('synced');
  }

  #onControl(message: ControlMessage): void {
    switch (message.kind) {
      case 'welcome': {
        const { role, roomEpoch, limits } = message.body;
        if (this.#epoch !== null && this.#epoch !== roomEpoch) {
          // Cleared (or restored) while we were away: our doc belongs to the old board.
          this.#resetDoc();
          this.#notice({ code: 'reset', message: 'Board was reset' });
        }
        this.#epoch = roomEpoch;
        this.#limits = limits;
        this.#tokenRejected = false;
        this.#welcomed = true;
        if (this.#role !== role) {
          this.#role = role;
          this.#emit('role', role);
        }
        const socket = this.#socket;
        this.#stableTimer = setTimeout(() => {
          if (this.#socket === socket) this.#attempt = 0;
        }, STABLE_AFTER_MS);
        this.#startPing();
        this.#pendingProbes.push(performance.now());
        this.#send(sync1Frame(this.#doc));
        // Bump our awareness clock: the server kept the clock we had before the drop, and it
        // ignores a state that doesn't move the clock forward.
        const local = this.#awareness.getLocalState();
        if (local !== null) this.#awareness.setLocalState(local);
        break;
      }
      case 'error':
        this.#lastError = { code: message.body.code, message: message.body.message };
        if (!message.body.fatal) this.#notice(this.#lastError);
        break;
      case 'ping':
        this.#sendControl({ kind: 'pong', seq: message.seq, body: message.body });
        break;
      case 'pong':
        this.#missedPongs = 0;
        break;
      case 'hello':
        break;
    }
  }

  #startPing(): void {
    this.#stopPing();
    this.#pingTimer = setInterval(() => {
      if (this.#missedPongs >= MISSED_PONGS_BEFORE_RECONNECT) {
        // The socket looks open but nothing comes back: a dead connection. Start over.
        const socket = this.#socket;
        this.#dropSocket();
        socket?.close(CloseCode.Normal, 'no_pong');
        this.#scheduleReconnect();
        return;
      }
      this.#missedPongs++;
      this.#sendControl({ kind: 'ping', seq: this.#nextSeq++, body: { t: Date.now() } });
    }, PING_INTERVAL_MS);
  }

  #stopPing(): void {
    if (this.#pingTimer) clearInterval(this.#pingTimer);
    this.#pingTimer = null;
  }

  #onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === this) return;
    if (this.#role === 'view') {
      // The UI disables every tool for viewers; reaching this is a client bug.
      if (this.#dev) throw new Error('A viewer tried to send a doc update');
      return;
    }
    // Before `welcome` (or offline) the edit just stays in the doc; the handshake carries it.
    if (this.#welcomed) this.#send(updateFrame(update));
  };

  #onAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin === this || !this.#welcomed) return;
    this.#send(awarenessFrame(this.#awareness, [...added, ...updated, ...removed]));
  };

  #sendControl(message: ControlMessage): void {
    this.#send(controlFrame(message));
  }

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
    this.#welcomed = false;
    this.#stopPing();
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
    const awareness = this.#awareness;
    const removed = [...awareness.getStates().keys()].filter((id) => id !== awareness.clientID);
    if (removed.length === 0) return;
    for (const id of removed) {
      awareness.states.delete(id);
      awareness.meta.delete(id);
    }
    const change = { added: [], updated: [], removed };
    awareness.emit('change', [change, this]);
    awareness.emit('update', [change, this]);
  }

  #scheduleReconnect(minDelayMs = 0): void {
    if (this.#stopReason || !this.#wantOnline) return;
    this.#clearReconnect();
    const delay = Math.max(minDelayMs, backoffDelay(this.#attempt, this.#random));
    this.#attempt++;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.#connect('connect');
    }, delay);
  }

  #clearReconnect(): void {
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
  }

  #notice(notice: Notice): void {
    this.#emit('notice', notice);
  }

  #stop(reason: StopReason): void {
    this.#clearReconnect();
    this.#stopReason = reason;
    this.#emit('stop', reason);
  }

  #setStatus(status: SyncStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    this.#emit('status', status);
  }

  #emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): void {
    for (const listener of this.#listeners[event]) {
      (listener as (...a: Parameters<Events[K]>) => void)(...args);
    }
  }
}
