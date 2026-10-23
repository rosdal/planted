import {
  Channel,
  CloseCode,
  type ControlMessage,
  controlFrame,
  decodeControl,
  decodeFrame,
  type Frame,
  ProtocolError,
  YjsType,
} from '@planted/protocol';
import type { ErrorMessage, RoomRole } from '@planted/schema';
import type { FastifyBaseLogger } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import { type FrameKind, SocketLimiter } from './limits';

/** Checked this often; a socket silent for `SILENCE_TIMEOUT_MS` is terminated. */
export const LIVENESS_CHECK_MS = 15_000;
/** Clients ping every 15 s, so this is three missed pings. */
export const SILENCE_TIMEOUT_MS = 45_000;
/** Above this, awareness frames are dropped for the socket; Yjs frames never are. */
export const MAX_BUFFERED_BYTES = 1024 * 1024;

/** A decoded frame; control frames arrive with their payload already parsed. */
export type Inbound =
  | { channel: 'control'; message: ControlMessage }
  | { channel: 'frame'; frame: Exclude<Frame, { channel: 0 }> };

let nextConnId = 1;

function kindOf(frame: Frame): FrameKind {
  if (frame.channel === Channel.Yjs) return frame.type === YjsType.Sync2 ? 'sync2' : 'yjs';
  if (frame.channel === Channel.Awareness) return 'awareness';
  return 'other';
}

/**
 * One socket. Decodes every frame, answers control pings itself, enforces the inbound rate
 * limits, and hands everything else to the current handler: the handshake until `welcome`,
 * then the room. The handler is set before the first await in the route, so nothing is lost.
 */
export class Connection {
  readonly id = nextConnId++;
  /** Awareness client ids this socket has announced; removed when it closes. */
  readonly clientIds = new Set<number>();
  readonly log: FastifyBaseLogger;
  /** Set from the verified token at `welcome`; never from anything the client says. */
  role: RoomRole | null = null;

  #handler: ((inbound: Inbound) => void) | null = null;
  #lastFrameAt = Date.now();
  #liveness: ReturnType<typeof setInterval>;
  #closeListeners = new Set<(code: number) => void>();
  #nextSeq = 1;
  readonly #limiter = new SocketLimiter();

  constructor(
    readonly socket: WebSocket,
    log: FastifyBaseLogger,
  ) {
    this.log = log.child({ connId: this.id });
    socket.binaryType = 'nodebuffer';
    socket.on('message', this.#onMessage);
    socket.on('close', (code) => {
      clearInterval(this.#liveness);
      for (const listener of this.#closeListeners) listener(code);
    });
    socket.on('error', (err) => this.log.warn({ err }, 'socket error'));
    this.#liveness = setInterval(() => {
      if (Date.now() - this.#lastFrameAt > SILENCE_TIMEOUT_MS) {
        this.log.info('silent for 45 s, terminating');
        socket.terminate();
      }
    }, LIVENESS_CHECK_MS);
  }

  get bufferedAmount(): number {
    return this.socket.bufferedAmount;
  }

  get isOpen(): boolean {
    return this.socket.readyState === this.socket.OPEN;
  }

  setHandler(handler: (inbound: Inbound) => void): void {
    this.#handler = handler;
  }

  onClose(listener: (code: number) => void): void {
    this.#closeListeners.add(listener);
  }

  /** `droppable` frames (awareness) are skipped when the socket is backed up. */
  send(bytes: Uint8Array, { droppable = false } = {}): void {
    if (!this.isOpen) return;
    if (droppable && this.socket.bufferedAmount > MAX_BUFFERED_BYTES) return;
    this.socket.send(bytes);
  }

  /** `seq` defaults to a fresh one; pass the request's seq for a reply. */
  sendControl(message: Omit<ControlMessage, 'seq'> & { seq?: number }): void {
    const seq = message.seq ?? this.#nextSeq++;
    this.send(controlFrame({ ...message, seq } as ControlMessage));
  }

  sendError(error: ErrorMessage, seq?: number): void {
    this.sendControl({ kind: 'error', body: error, ...(seq === undefined ? {} : { seq }) });
  }

  close(code: number, reason: string): void {
    if (this.socket.readyState === this.socket.CLOSED) return;
    this.socket.close(code, reason);
  }

  /** A fatal `error` frame, then the close, so the client can show why. */
  fail(code: number, errorCode: string, message: string, seq?: number): void {
    this.sendError({ code: errorCode, message, fatal: true }, seq);
    this.close(code, errorCode);
  }

  #onMessage = (data: RawData, isBinary: boolean): void => {
    if (!this.isOpen) return;
    this.#lastFrameAt = Date.now();
    if (!isBinary || !Buffer.isBuffer(data)) {
      this.log.warn('text frame received');
      this.close(CloseCode.BadFrame, 'bad_frame');
      return;
    }
    // A view over the Buffer's memory, not a copy.
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    let inbound: Inbound;
    try {
      const frame = decodeFrame(bytes);
      inbound =
        frame.channel === Channel.Control
          ? { channel: 'control', message: decodeControl(frame) }
          : { channel: 'frame', frame };
    } catch (err) {
      if (!(err instanceof ProtocolError)) throw err;
      this.log.warn({ code: err.code, detail: err.message }, 'malformed frame');
      this.close(CloseCode.BadFrame, err.code);
      return;
    }

    const verdict = this.#limiter.check(
      inbound.channel === 'control' ? 'other' : kindOf(inbound.frame),
      bytes.byteLength,
    );
    if (verdict === 'close') {
      this.log.warn('yjs frames over the rate limit for 2 s');
      this.fail(CloseCode.RateLimited, 'rate_limited', 'Too many frames');
      return;
    }
    if (verdict === 'drop') return;

    if (inbound.channel === 'control' && inbound.message.kind === 'ping') {
      this.sendControl({ kind: 'pong', seq: inbound.message.seq, body: inbound.message.body });
      return;
    }
    this.#handler?.(inbound);
  };
}
