import {
  ErrorMessage,
  HelloMessage,
  KickMessage,
  PingMapMessage,
  PingMessage,
  PongMessage,
  WelcomeMessage,
} from '@planted/schema';
import { Encoder } from 'cbor-x';
import type { z } from 'zod';
import { ProtocolError } from './errors';
import {
  type AppFrame,
  AppType,
  Channel,
  type ControlFrame,
  ControlType,
  encodeFrame,
} from './frame';

/**
 * Plain CBOR, so Breached decodes it with `ciborium`: no cbor-x record extension, and byte
 * arrays as CBOR byte strings rather than tagged typed arrays.
 */
const cbor = new Encoder({ useRecords: false, tagUint8Array: false, mapsAsObjects: true });

const controlSchemas = {
  hello: HelloMessage,
  welcome: WelcomeMessage,
  error: ErrorMessage,
  ping: PingMessage,
  pong: PongMessage,
} as const;
type ControlKind = keyof typeof controlSchemas;

const controlTypes = {
  hello: ControlType.Hello,
  welcome: ControlType.Welcome,
  error: ControlType.Error,
  ping: ControlType.Ping,
  pong: ControlType.Pong,
} as const satisfies Record<ControlKind, ControlFrame['type']>;

const controlKinds = Object.fromEntries(
  Object.entries(controlTypes).map(([kind, type]) => [type, kind]),
) as Record<ControlFrame['type'], ControlKind>;

export type ControlMessage = {
  [K in ControlKind]: { kind: K; seq: number; body: z.infer<(typeof controlSchemas)[K]> };
}[ControlKind];

const appSchemas = { 'ping-map': PingMapMessage, kick: KickMessage } as const;
type AppKind = keyof typeof appSchemas;

const appTypes = { 'ping-map': AppType.PingMap, kick: AppType.Kick } as const satisfies Record<
  AppKind,
  AppFrame['type']
>;

const appKinds = Object.fromEntries(
  Object.entries(appTypes).map(([kind, type]) => [type, kind]),
) as Record<AppFrame['type'], AppKind>;

export type AppMessage = {
  [K in AppKind]: { kind: K; body: z.infer<(typeof appSchemas)[K]> };
}[AppKind];

function decodePayload<T>(schema: z.ZodType<T>, payload: Uint8Array, what: string): T {
  let value: unknown;
  try {
    value = cbor.decode(payload);
  } catch {
    throw new ProtocolError('bad_payload', `${what} is not CBOR`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.') || i.code).join(', ');
    throw new ProtocolError('bad_payload', `${what} failed validation: ${fields}`);
  }
  return parsed.data;
}

/** Validates the body against its schema before encoding, so neither side sends garbage. */
export function controlFrame(message: ControlMessage): Uint8Array {
  const body = controlSchemas[message.kind].parse(message.body);
  return encodeFrame({
    channel: Channel.Control,
    type: controlTypes[message.kind],
    seq: message.seq,
    payload: cbor.encode(body),
  });
}

/** Throws `ProtocolError('bad_payload')` for anything that isn't exactly the schema. */
export function decodeControl(frame: ControlFrame): ControlMessage {
  const kind = controlKinds[frame.type];
  const body = decodePayload<unknown>(controlSchemas[kind], frame.payload, kind);
  // The schema for `kind` produced `body`, so the pair matches.
  return { kind, seq: frame.seq, body } as ControlMessage;
}

export function appFrame(message: AppMessage): Uint8Array {
  const body = appSchemas[message.kind].parse(message.body);
  return encodeFrame({
    channel: Channel.App,
    type: appTypes[message.kind],
    payload: cbor.encode(body),
  });
}

export function decodeApp(frame: AppFrame): AppMessage {
  const kind = appKinds[frame.type];
  const body = decodePayload<unknown>(appSchemas[kind], frame.payload, kind);
  return { kind, body } as AppMessage;
}
