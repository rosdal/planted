import { type Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { AwarenessType, Channel, encodeFrame, YjsType } from './frame';

// Builders for the frames both sides send. Payloads are plain Yjs primitives, not
// `y-protocols/sync` messages, which would add a second type prefix inside ours.

export function sync1Frame(doc: Y.Doc): Uint8Array {
  return encodeFrame({
    channel: Channel.Yjs,
    type: YjsType.Sync1,
    payload: Y.encodeStateVector(doc),
  });
}

export function sync2Frame(doc: Y.Doc, remoteStateVector: Uint8Array): Uint8Array {
  return encodeFrame({
    channel: Channel.Yjs,
    type: YjsType.Sync2,
    payload: Y.encodeStateAsUpdate(doc, remoteStateVector),
  });
}

export function updateFrame(update: Uint8Array): Uint8Array {
  return encodeFrame({ channel: Channel.Yjs, type: YjsType.Update, payload: update });
}

export function awarenessFrame(awareness: Awareness, clients: readonly number[]): Uint8Array {
  return encodeFrame({
    channel: Channel.Awareness,
    type: AwarenessType.Update,
    payload: encodeAwarenessUpdate(awareness, [...clients]),
  });
}
