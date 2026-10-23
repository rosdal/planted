import { ProtocolError } from './errors';

/**
 * Frame layout from docs/design.md, "Wire protocol", without `seq` for now:
 *
 *   byte 0   channel   1 = yjs, 2 = awareness   (0 control and 3 app arrive in 0.4)
 *   byte 1   type      yjs: 0 sync-1, 1 sync-2, 2 update   awareness: 0 update
 *   byte 2+  payload   raw Yjs bytes, untouched
 */
export const Channel = { Yjs: 1, Awareness: 2 } as const;
export const YjsType = { Sync1: 0, Sync2: 1, Update: 2 } as const;
export const AwarenessType = { Update: 0 } as const;

export type Frame =
  | { channel: 1; type: 0 | 1 | 2; payload: Uint8Array }
  | { channel: 2; type: 0; payload: Uint8Array };

const HEADER_BYTES = 2;

/** 256 KB, header included: the cap for updates, awareness and sync-1. */
export const MAX_FRAME_BYTES = 256 * 1024;

/**
 * sync-2 is the one frame that carries a whole doc (a first join, or a client re-uploading
 * after a server restart), so it is capped at the 5 MB doc limit instead; under the 256 KB cap
 * a doc past 256 KB could never sync. The server's WebSocket `maxPayload` uses this number.
 */
export const MAX_SYNC_FRAME_BYTES = 5 * 1024 * 1024 + HEADER_BYTES;

export function encodeFrame(f: Frame): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + f.payload.byteLength);
  out[0] = f.channel;
  out[1] = f.type;
  out.set(f.payload, HEADER_BYTES);
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
    case Channel.Yjs:
      if (type === YjsType.Sync1 || type === YjsType.Sync2 || type === YjsType.Update) {
        return { channel, type, payload };
      }
      break;
    case Channel.Awareness:
      if (type === AwarenessType.Update) return { channel, type, payload };
      break;
    default:
      throw new ProtocolError('unknown_channel', `unknown channel ${channel}`);
  }
  throw new ProtocolError('unknown_type', `unknown type ${type} on channel ${channel}`);
}
