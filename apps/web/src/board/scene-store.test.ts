import { commitStroke, newObjectId, objectsOf, type StrokeInput } from '@planted/client';
import type { StrokeObject } from '@planted/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { type SceneSink, SceneStore } from './scene-store';

class FakeSink implements SceneSink {
  readonly objects = new Map<string, StrokeObject>();
  readonly calls: string[] = [];
  create(id: string, object: StrokeObject) {
    this.calls.push(`create ${id}`);
    this.objects.set(id, object);
  }
  update(id: string, object: StrokeObject) {
    this.calls.push(`update ${id}`);
    this.objects.set(id, object);
  }
  remove(id: string) {
    this.calls.push(`remove ${id}`);
    this.objects.delete(id);
  }
}

function stroke(overrides: Partial<StrokeInput> = {}): StrokeInput {
  return {
    id: newObjectId(),
    floor: 'test-1',
    colour: '#57ab5a',
    width: 0.002,
    points: [0.1, 0.1, 0.5, 0.5],
    epsilon: 0,
    by: 'Ash',
    ...overrides,
  };
}

function setup() {
  const doc = new Y.Doc();
  const sink = new FakeSink();
  const store = new SceneStore(objectsOf(doc), sink);
  return { doc, sink, store, objects: objectsOf(doc) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SceneStore', () => {
  it('adds a committed stroke on the next flush, not inside the Yjs callback', () => {
    const { doc, sink, store } = setup();
    const input = stroke();
    commitStroke(doc, input);
    expect(sink.calls).toEqual([]);
    expect(store.flush()).toBe(1);
    expect(sink.calls).toEqual([`create ${input.id}`]);
    expect(sink.objects.get(input.id)?.by).toBe('Ash');
  });

  it('rebuilds an object when one of its fields changes', () => {
    const { doc, sink, store, objects } = setup();
    const input = stroke();
    commitStroke(doc, input);
    store.flush();
    objects.get(input.id)?.set('colour', '#e5534b');
    store.flush();
    expect(sink.calls).toEqual([`create ${input.id}`, `update ${input.id}`]);
    expect(sink.objects.get(input.id)?.colour).toBe('#e5534b');
  });

  it('removes deleted objects', () => {
    const { doc, sink, store, objects } = setup();
    const input = stroke();
    commitStroke(doc, input);
    store.flush();
    objects.delete(input.id);
    store.flush();
    expect(sink.objects.size).toBe(0);
    expect(store.size).toBe(0);
  });

  it('turns 100 changes in one tick into one flush that touches each id once', () => {
    const { doc, sink, store, objects } = setup();
    const inputs = Array.from({ length: 100 }, () => stroke());
    for (const input of inputs) commitStroke(doc, input);
    for (const input of inputs) objects.get(input.id)?.set('by', 'Mute');
    expect(store.flush()).toBe(100);
    expect(sink.calls).toHaveLength(100);
    expect(sink.calls.every((c) => c.startsWith('create '))).toBe(true);
    expect([...sink.objects.values()].every((o) => o.by === 'Mute')).toBe(true);
    expect(store.flush()).toBe(0);
  });

  it('builds what is already in the doc in its first flush', () => {
    const doc = new Y.Doc();
    for (let i = 0; i < 5; i++) commitStroke(doc, stroke());
    const sink = new FakeSink();
    const store = new SceneStore(objectsOf(doc), sink);
    store.flush();
    expect(sink.objects.size).toBe(5);
  });

  it('skips invalid objects and warns once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { doc, sink, store, objects } = setup();
    const bad = new Y.Map<unknown>();
    doc.transact(() => {
      objects.set('badbadbadbad', bad);
      bad.set('kind', 'stroke');
      bad.set('colour', 'not a colour');
    });
    store.flush();
    bad.set('width', 99);
    store.flush();
    expect(sink.calls).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('removes an object that turns invalid', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { doc, sink, store, objects } = setup();
    const input = stroke();
    commitStroke(doc, input);
    store.flush();
    objects.get(input.id)?.set('width', 5);
    store.flush();
    expect(sink.calls).toEqual([`create ${input.id}`, `remove ${input.id}`]);
  });

  it('stops listening once destroyed', () => {
    const { doc, sink, store } = setup();
    store.destroy();
    commitStroke(doc, stroke());
    store.flush();
    expect(sink.calls).toEqual([]);
  });
});
