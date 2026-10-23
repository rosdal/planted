import { decodeFrame, type Frame, ProtocolError } from '@planted/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { RawData, WebSocket } from 'ws';

export const CloseCode = {
  Normal: 1000,
  GoingAway: 1001,
  Internal: 1011,
  BadUpdate: 4400,
  RoomNotFound: 4404,
} as const;

export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_TIMEOUT_MS = 30_000;
/** Above this, awareness frames are dropped for the socket; Yjs frames never are. */
export const MAX_BUFFERED_BYTES = 1024 * 1024;

let nextConnId = 1;

/**
 * One socket. Frames are decoded and queued from the first byte, before the room is known
 * (the room lookup is async and the client sends sync-1 as soon as the socket opens), then
 * handed to the room once `attach` is called.
 */
export class Connection {
  readonly id = nextConnId++;
  /** Awareness client ids this socket has announced; removed when it closes. */
  readonly clientIds = new Set<number>();
  readonly log: FastifyBaseLogger;

  #handler: ((frame: Frame) => void) | null = null;
  #queue: Frame[] = [];
  #lastPong = Date.now();
  #heartbeat: ReturnType<typeof setInterval>;
  #closeListeners = new Set<(code: number) => void>();

  constructor(
    readonly socket: WebSocket,
    log: FastifyBaseLogger,
  ) {
    this.log = log.child({ connId: this.id });
    socket.binaryType = 'nodebuffer';
    socket.on('message', this.#onMessage);
    socket.on('pong', () => {
      this.#lastPong = Date.now();
    });
    socket.on('close', (code) => {
      clearInterval(this.#heartbeat);
      for (const listener of this.#closeListeners) listener(code);
    });
    socket.on('error', (err) => this.log.warn({ err }, 'socket error'));
    this.#heartbeat = setInterval(() => {
      if (Date.now() - this.#lastPong > HEARTBEAT_TIMEOUT_MS) {
        this.log.info('no pong within 30 s, terminating');
        socket.terminate();
        return;
      }
      if (socket.readyState === socket.OPEN) socket.ping();
    }, HEARTBEAT_INTERVAL_MS);
  }

  get bufferedAmount(): number {
    return this.socket.bufferedAmount;
  }

  attach(handler: (frame: Frame) => void): void {
    this.#handler = handler;
    const queued = this.#queue;
    this.#queue = [];
    for (const frame of queued) {
      if (!this.isOpen) return;
      handler(frame);
    }
  }

  onClose(listener: (code: number) => void): void {
    this.#closeListeners.add(listener);
  }

  get isOpen(): boolean {
    return this.socket.readyState === this.socket.OPEN;
  }

  /** `droppable` frames (awareness) are skipped when the socket is backed up. */
  send(bytes: Uint8Array, { droppable = false } = {}): void {
    if (!this.isOpen) return;
    if (droppable && this.socket.bufferedAmount > MAX_BUFFERED_BYTES) return;
    this.socket.send(bytes);
  }

  close(code: number, reason: string): void {
    if (this.socket.readyState === this.socket.CLOSED) return;
    this.socket.close(code, reason);
  }

  #onMessage = (data: RawData, isBinary: boolean): void => {
    if (!this.isOpen) return;
    if (!isBinary || !Buffer.isBuffer(data)) {
      this.log.warn('text frame received');
      this.close(CloseCode.BadUpdate, 'bad_frame');
      return;
    }
    // A view over the Buffer's memory, not a copy.
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    let frame: Frame;
    try {
      frame = decodeFrame(bytes);
    } catch (err) {
      if (!(err instanceof ProtocolError)) throw err;
      this.log.warn({ code: err.code }, 'malformed frame');
      this.close(CloseCode.BadUpdate, err.code);
      return;
    }
    if (this.#handler) this.#handler(frame);
    else this.#queue.push(frame);
  };
}
