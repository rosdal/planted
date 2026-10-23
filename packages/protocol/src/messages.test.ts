import { describe, expect, it } from 'vitest';
import { Awareness, applyAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { decodeFrame } from './frame';
import { awarenessFrame, sync1Frame, sync2Frame, updateFrame } from './messages';

describe('message builders', () => {
  it('sync-1 then sync-2 brings an empty doc up to date', () => {
    const a = new Y.Doc();
    a.getArray<string>('items').push(['one', 'two']);
    const b = new Y.Doc();

    const sync1 = decodeFrame(sync1Frame(b));
    expect(sync1).toMatchObject({ channel: 1, type: 0 });
    const sync2 = decodeFrame(sync2Frame(a, sync1.payload));
    expect(sync2).toMatchObject({ channel: 1, type: 1 });

    Y.applyUpdate(b, sync2.payload);
    expect(b.getArray('items').toArray()).toEqual(['one', 'two']);
  });

  it('wraps an update without changing its bytes', () => {
    const update = new Uint8Array([1, 2, 3]);
    expect(decodeFrame(updateFrame(update))).toEqual({ channel: 1, type: 2, payload: update });
  });

  it('carries an awareness state across', () => {
    const a = new Awareness(new Y.Doc());
    a.setLocalStateField('user', { name: 'ash' });
    const b = new Awareness(new Y.Doc());

    const frame = decodeFrame(awarenessFrame(a, [a.clientID]));
    expect(frame).toMatchObject({ channel: 2, type: 0 });
    applyAwarenessUpdate(b, frame.payload, null);
    expect(b.getStates().get(a.clientID)).toEqual({ user: { name: 'ash' } });
    a.destroy();
    b.destroy();
  });
});
