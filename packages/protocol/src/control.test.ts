import { Encoder } from 'cbor-x';
import { describe, expect, it } from 'vitest';
import {
  type AppMessage,
  appFrame,
  type ControlMessage,
  controlFrame,
  decodeApp,
  decodeControl,
} from './control';
import { ProtocolError } from './errors';
import { type AppFrame, type ControlFrame, decodeFrame, encodeFrame } from './frame';

const cbor = new Encoder({ useRecords: false, tagUint8Array: false, mapsAsObjects: true });

function control(bytes: Uint8Array): ControlFrame {
  const frame = decodeFrame(bytes);
  if (frame.channel !== 0) throw new Error(`channel ${frame.channel}, expected control`);
  return frame;
}

function app(bytes: Uint8Array): AppFrame {
  const frame = decodeFrame(bytes);
  if (frame.channel !== 3) throw new Error(`channel ${frame.channel}, expected app`);
  return frame;
}

/** A control frame whose payload is `value` as CBOR, bypassing `controlFrame`'s validation. */
function rawControl(type: ControlFrame['type'], value: unknown): ControlFrame {
  return control(encodeFrame({ channel: 0, type, seq: 1, payload: cbor.encode(value) }));
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

const limits = { maxFrameBytes: 262_144, maxObjects: 20_000 };

describe('control messages', () => {
  it.each<ControlMessage>([
    { kind: 'hello', seq: 1, body: { protocol: 1, token: 'jwt', clientName: 'Ash' } },
    {
      kind: 'hello',
      seq: 2,
      body: { protocol: 1, token: 'jwt', clientName: 'Ash', stateVector: new Uint8Array([1, 2]) },
    },
    {
      kind: 'welcome',
      seq: 1,
      body: { role: 'edit', roomEpoch: 3, serverTime: 1_761_000_000_000, limits },
    },
    { kind: 'welcome', seq: 1, body: { role: 'view', roomEpoch: 1, serverTime: 0, limits } },
    {
      kind: 'error',
      seq: 0,
      body: { code: 'object_limit', message: 'Board is full', fatal: false },
    },
    { kind: 'ping', seq: 9, body: { t: 1234.5 } },
    { kind: 'pong', seq: 9, body: { t: 1234.5 } },
  ])('round-trips $kind through CBOR', (message) => {
    const decoded = decodeControl(control(controlFrame(message)));
    expect(decoded.kind).toBe(message.kind);
    expect(decoded.seq).toBe(message.seq);
    // Byte strings come back as Node Buffers; compare their bytes, not their class.
    expect(JSON.parse(JSON.stringify(decoded.body))).toEqual(
      JSON.parse(JSON.stringify(message.body)),
    );
  });

  it('keeps a state vector as bytes', () => {
    const stateVector = new Uint8Array([5, 6, 7]);
    const decoded = decodeControl(
      control(
        controlFrame({
          kind: 'hello',
          seq: 1,
          body: { protocol: 1, token: 't', clientName: 'n', stateVector },
        }),
      ),
    );
    if (decoded.kind !== 'hello') throw new Error('not a hello');
    expect(decoded.body.stateVector).toBeInstanceOf(Uint8Array);
    expect([...(decoded.body.stateVector ?? [])]).toEqual([5, 6, 7]);
  });

  it('writes plain CBOR: a map, with bytes as an untagged byte string', () => {
    const { payload } = control(
      controlFrame({
        kind: 'hello',
        seq: 1,
        body: {
          protocol: 1,
          token: 't',
          clientName: 'n',
          stateVector: new Uint8Array([1, 2, 3, 4]),
        },
      }),
    );
    // Major type 5 (map) in the top three bits; cbor-x records would start with a tag instead.
    expect((payload[0] ?? 0) >> 5).toBe(5);
    // 0x44 = byte string of length 4, then the bytes; 0xd8 0x40 would be cbor-x's tag 64
    // (typed array), which ciborium reads as a tagged value instead of bytes.
    const bytes = Buffer.from(payload);
    expect(bytes.includes(Buffer.from([0x44, 1, 2, 3, 4]))).toBe(true);
    expect(bytes.includes(Buffer.from([0xd8, 0x40, 0x44]))).toBe(false);
  });

  it.each([
    ['an unknown field', 3, { t: 1, extra: true }],
    ['a missing field', 1, { role: 'edit', roomEpoch: 1, serverTime: 0 }],
    [
      'an unknown field inside limits',
      1,
      { role: 'edit', roomEpoch: 1, serverTime: 0, limits: { ...limits, more: 1 } },
    ],
    ['an unknown role', 1, { role: 'owner', roomEpoch: 1, serverTime: 0, limits }],
    ['epoch 0', 1, { role: 'edit', roomEpoch: 0, serverTime: 0, limits }],
    ['a string where a number goes', 4, { t: '1' }],
    ['an empty token', 0, { protocol: 1, token: '', clientName: 'n' }],
    ['an array instead of a map', 3, [1]],
  ] as const)('rejects %s', (_, type, value) => {
    expect(codeOf(() => decodeControl(rawControl(type, value)))).toBe('bad_payload');
  });

  it('rejects a payload that is not CBOR', () => {
    const frame = control(
      encodeFrame({ channel: 0, type: 3, seq: 1, payload: new Uint8Array([0xff, 0xff]) }),
    );
    expect(codeOf(() => decodeControl(frame))).toBe('bad_payload');
  });

  it('refuses to encode a body that fails its schema', () => {
    const bad = { kind: 'ping', seq: 1, body: { t: Number.NaN } } as const;
    expect(() => controlFrame(bad)).toThrow();
  });
});

describe('app messages', () => {
  it.each<AppMessage>([
    { kind: 'ping-map', body: { at: { x: 0.5, y: 0.25 }, floor: 'test-1', kind: 'danger' } },
    { kind: 'kick', body: { userId: 'u1' } },
  ])('round-trips $kind through CBOR', (message) => {
    expect(decodeApp(app(appFrame(message)))).toEqual(message);
  });

  it('rejects an unknown field', () => {
    const frame = app(
      encodeFrame({ channel: 3, type: 2, payload: cbor.encode({ userId: 'u1', reason: 'x' }) }),
    );
    expect(codeOf(() => decodeApp(frame))).toBe('bad_payload');
  });
});
