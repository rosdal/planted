import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ProtocolError } from './errors';
import {
  decodeFrame,
  encodeFrame,
  type Frame,
  MAX_FRAME_BYTES,
  MAX_SEQ,
  MAX_SYNC_FRAME_BYTES,
} from './frame';

const payload = new Uint8Array([7, 8, 9]);

/** `size` bytes in total, starting with the given header. */
function sized(channel: number, type: number, size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes[0] = channel;
  bytes[1] = type;
  return bytes;
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof ProtocolError) return err.code;
    throw err;
  }
  return undefined;
}

const validFrame: fc.Arbitrary<Frame> = fc.oneof(
  fc.record({
    channel: fc.constant(0 as const),
    type: fc.constantFrom(0 as const, 1 as const, 2 as const, 3 as const, 4 as const),
    seq: fc.nat({ max: MAX_SEQ }),
    payload: fc.uint8Array({ maxLength: 4096 }),
  }),
  fc.record({
    channel: fc.constant(3 as const),
    type: fc.constantFrom(1 as const, 2 as const),
    payload: fc.uint8Array({ maxLength: 4096 }),
  }),
  fc.record({
    channel: fc.constant(1 as const),
    type: fc.constantFrom(0 as const, 1 as const, 2 as const),
    payload: fc.uint8Array({ maxLength: 4096 }),
  }),
  fc.record({
    channel: fc.constant(2 as const),
    type: fc.constant(0 as const),
    payload: fc.uint8Array({ maxLength: 4096 }),
  }),
);

describe('encodeFrame / decodeFrame', () => {
  it.each<Frame>([
    { channel: 1, type: 0, payload },
    { channel: 1, type: 1, payload },
    { channel: 1, type: 2, payload },
    { channel: 2, type: 0, payload },
    { channel: 1, type: 2, payload: new Uint8Array() },
    { channel: 0, type: 0, seq: 7, payload },
    { channel: 0, type: 4, seq: MAX_SEQ, payload: new Uint8Array() },
    { channel: 3, type: 1, payload },
    { channel: 3, type: 2, payload },
  ])('round-trips channel $channel type $type', (frame) => {
    const bytes = encodeFrame(frame);
    expect(bytes[0]).toBe(frame.channel);
    expect(bytes[1]).toBe(frame.type);
    expect(decodeFrame(bytes)).toEqual(frame);
  });

  it('returns the payload as a view, not a copy', () => {
    const bytes = encodeFrame({ channel: 1, type: 2, payload });
    const decoded = decodeFrame(bytes);
    expect(decoded.payload.buffer).toBe(bytes.buffer);
    expect(decoded.payload.byteOffset).toBe(bytes.byteOffset + 2);
  });

  it.each([
    { name: '0 bytes', bytes: new Uint8Array(), code: 'short_frame' },
    { name: '1 byte', bytes: new Uint8Array([1]), code: 'short_frame' },
    { name: 'control without a seq', bytes: new Uint8Array([0, 0]), code: 'short_frame' },
    {
      name: 'control with half a seq',
      bytes: new Uint8Array([0, 3, 0, 0, 1]),
      code: 'short_frame',
    },
    { name: 'control type 5', bytes: new Uint8Array([0, 5, 0, 0, 0, 1]), code: 'unknown_type' },
    { name: 'app type 0', bytes: new Uint8Array([3, 0, 1]), code: 'unknown_type' },
    { name: 'channel 4', bytes: new Uint8Array([4, 0, 1]), code: 'unknown_channel' },
    { name: 'channel 255', bytes: new Uint8Array([255, 0]), code: 'unknown_channel' },
    { name: 'yjs type 3', bytes: new Uint8Array([1, 3]), code: 'unknown_type' },
    { name: 'awareness type 1', bytes: new Uint8Array([2, 1, 0]), code: 'unknown_type' },
    {
      name: 'an update over 256 KB',
      bytes: sized(1, 2, MAX_FRAME_BYTES + 1),
      code: 'frame_too_large',
    },
    {
      name: 'a sync-1 over 256 KB',
      bytes: sized(1, 0, MAX_FRAME_BYTES + 1),
      code: 'frame_too_large',
    },
    {
      name: 'awareness over 256 KB',
      bytes: sized(2, 0, MAX_FRAME_BYTES + 1),
      code: 'frame_too_large',
    },
    {
      name: 'a sync-2 over 5 MB',
      bytes: sized(1, 1, MAX_SYNC_FRAME_BYTES + 1),
      code: 'frame_too_large',
    },
  ])('rejects $name with $code', ({ bytes, code }) => {
    expect(codeOf(() => decodeFrame(bytes))).toBe(code);
  });

  it('writes seq as a big-endian u32 between the header and the payload', () => {
    const bytes = encodeFrame({ channel: 0, type: 3, seq: 0x01020304, payload });
    expect([...bytes]).toEqual([0, 3, 1, 2, 3, 4, 7, 8, 9]);
  });

  it.each([-1, MAX_SEQ + 1, 1.5])('refuses to encode seq %s', (seq) => {
    expect(() => encodeFrame({ channel: 0, type: 3, seq, payload })).toThrow(RangeError);
  });

  it('accepts a sync-2 above 256 KB, since it may carry a whole doc', () => {
    const bytes = encodeFrame({ channel: 1, type: 1, payload: new Uint8Array(MAX_FRAME_BYTES) });
    expect(decodeFrame(bytes).payload.byteLength).toBe(MAX_FRAME_BYTES);
  });

  it('accepts a frame of exactly MAX_FRAME_BYTES', () => {
    const bytes = encodeFrame({
      channel: 1,
      type: 2,
      payload: new Uint8Array(MAX_FRAME_BYTES - 2),
    });
    expect(decodeFrame(bytes).payload.byteLength).toBe(MAX_FRAME_BYTES - 2);
  });

  it('round-trips any valid frame byte-identical', () => {
    fc.assert(
      fc.property(validFrame, (f) => {
        const bytes = encodeFrame(f);
        const decoded = decodeFrame(bytes);
        expect(decoded).toEqual(f);
        expect(encodeFrame(decoded)).toEqual(bytes);
      }),
    );
  });

  it('either decodes or throws ProtocolError for arbitrary bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
        try {
          decodeFrame(bytes);
        } catch (err) {
          expect(err).toBeInstanceOf(ProtocolError);
        }
      }),
    );
  });
});
