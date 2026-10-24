import { ProtocolError } from './errors';

/**
 * Frame layout from docs/design.md, "Wire protocol":
 *
 *   byte 0     channel   0 = control, 1 = yjs, 2 = awareness, 3 = app
 *   byte 1     type      control: 0 hello, 1 welcome, 2 error, 3 ping, 4 pong
 *                        yjs: 0 sync-1, 1 sync-2, 2 update   awareness: 0 update
 *                        app: 1 ping-map, 2 kick
 *   bytes 2–5  seq       control only: u32, big-endian; a reply carries its request's seq
 *   then       payload   yjs and awareness: raw Yjs bytes; control and app: CBOR
 *
 * The protocol is frozen at v1 from 0.4 on: a change bumps `hello.protocol`.
 */
export const Channel = { Control: 0, Yjs: 1, Awareness: 2, App: 3 } as const;
export const ControlType = { Hello: 0, Welcome: 1, Error: 2, Ping: 3, Pong: 4 } as const;
export const YjsType = { Sync1: 0, Sync2: 1, Update: 2 } as const;
export const AwarenessType = { Update: 0 } as const;
export const AppType = { PingMap: 1, Kick: 2 } as const;

export type Frame =
  | { channel: 0; type: 0 | 1 | 2 | 3 | 4; seq: number; payload: Uint8Array }
  | { channel: 1; type: 0 | 1 | 2; payload: Uint8Array }
  | { channel: 2; type: 0; payload: Uint8Array }
  | { channel: 3; type: 1 | 2; payload: Uint8Array };
export type ControlFrame = Extract<Frame, { channel: 0 }>;
export type AppFrame = Extract<Frame, { channel: 3 }>;

const HEADER_BYTES = 2;
const SEQ_BYTES = 4;
export const MAX_SEQ = 0xffff_ffff;

/** 256 KB, header included: the cap for every frame except sync-2. */
export const MAX_FRAME_BYTES = 256 * 1024;

/**
 * sync-2 is the one frame that carries a whole doc (a first join, or a client re-uploading
 * after a server restart), so it is capped at the 5 MB doc limit instead; under the 256 KB cap
 * a doc past 256 KB could never sync. The server's WebSocket `maxPayload` uses this number.
 */
export const MAX_SYNC_FRAME_BYTES = 5 * 1024 * 1024 + HEADER_BYTES;

export function encodeFrame(f: Frame): Uint8Array {
  const header = f.channel === Channel.Control ? HEADER_BYTES + SEQ_BYTES : HEADER_BYTES;
  const out = new Uint8Array(header + f.payload.byteLength);
  out[0] = f.channel;
  out[1] = f.type;
  if (f.channel === Channel.Control) {
    if (!Number.isInteger(f.seq) || f.seq < 0 || f.seq > MAX_SEQ) {
      throw new RangeError(`seq ${f.seq} is not a u32`);
    }
    new DataView(out.buffer, out.byteOffset, out.byteLength).setUint32(HEADER_BYTES, f.seq);
  }
  out.set(f.payload, header);
  return out;
}

/** The payload is a view into `bytes` (no copy), so it is only valid as long as `bytes` is. */
export function decodeFrame(bytes: Uint8Array): Frame {
  const channel = bytes[0];
  const type = bytes[1];
  if (channel === undefined || type === undefined) {
    throw new ProtocolError(
      'short_frame',
      `frame is ${bytes.byteLength} bytes, need ${HEADER_BYTES}`,
    );
  }
  const limit =
    channel === Channel.Yjs && type === YjsType.Sync2 ? MAX_SYNC_FRAME_BYTES : MAX_FRAME_BYTES;
  if (bytes.byteLength > limit) {
    throw new ProtocolError(
      'frame_too_large',
      `frame is ${bytes.byteLength} bytes, limit ${limit}`,
    );
  }
  const payload = bytes.subarray(HEADER_BYTES);
  switch (channel) {
    case Channel.Control: {
      if (bytes.byteLength < HEADER_BYTES + SEQ_BYTES) {
        throw new ProtocolError(
          'short_frame',
          `control frame is ${bytes.byteLength} bytes, need ${HEADER_BYTES + SEQ_BYTES}`,
        );
      }
      if (
        type === ControlType.Hello ||
        type === ControlType.Welcome ||
        type === ControlType.Error ||
        type === ControlType.Ping ||
        type === ControlType.Pong
      ) {
        const seq = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
          HEADER_BYTES,
        );
        return { channel, type, seq, payload: bytes.subarray(HEADER_BYTES + SEQ_BYTES) };
      }
      break;
    }
    case Channel.Yjs:
      if (type === YjsType.Sync1 || type === YjsType.Sync2 || type === YjsType.Update) {
        return { channel, type, payload };
      }
      break;
    case Channel.Awareness:
      if (type === AwarenessType.Update) return { channel, type, payload };
      break;
    case Channel.App:
      if (type === AppType.PingMap || type === AppType.Kick) return { channel, type, payload };
      break;
    default:
      throw new ProtocolError('unknown_channel', `unknown channel ${channel}`);
  }
  throw new ProtocolError('unknown_type', `unknown type ${type} on channel ${channel}`);
}
