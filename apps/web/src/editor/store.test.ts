import { describe, expect, it } from 'vitest';
import { emptyTimeline } from '@vf/shared';
import { addClip, findClip, moveClip } from '@vf/timeline';
import { createEditorStore, createUiStore } from './store';

const seeded = () => {
  const r = addClip(emptyTimeline('9:16'), { id: 'a', kind: 'image' }, { at: 0 }, () => `id${Math.random()}`);
  return { store: createEditorStore(r.doc), clipId: r.doc.tracks[0]!.clips[0]!.id };
};
const startOf = (s: ReturnType<typeof seeded>['store'], id: string) => findClip(s.getState().doc, id)!.clip.start;

describe('editor store', () => {
  it('a gesture of 20 moves is one undo step', () => {
    const { store, clipId } = seeded();
    store.getState().beginGesture();
    for (let i = 1; i <= 20; i++) store.getState().apply((d) => moveClip(d, clipId, i / 10, {}));
    store.getState().endGesture();
    expect(startOf(store, clipId)).toBe(2);
    expect(store.temporal.getState().pastStates).toHaveLength(1);
    store.temporal.getState().undo();
    expect(startOf(store, clipId)).toBe(0);
  });

  it('undo/redo restores doc', () => {
    const { store, clipId } = seeded();
    store.getState().apply((d) => moveClip(d, clipId, 3, {}));
    store.getState().apply((d) => moveClip(d, clipId, 7, {}));
    store.temporal.getState().undo();
    expect(startOf(store, clipId)).toBe(3);
    store.temporal.getState().undo();
    expect(startOf(store, clipId)).toBe(0);
    store.temporal.getState().redo();
    expect(startOf(store, clipId)).toBe(3);
  });

  it('an op that changes nothing is not a history step', () => {
    const { store } = seeded();
    store.getState().apply((d) => d);
    expect(store.temporal.getState().pastStates).toHaveLength(0);
  });

  it('a gesture that changes nothing is not a history step', () => {
    const { store } = seeded();
    store.getState().beginGesture();
    store.getState().endGesture();
    expect(store.temporal.getState().pastStates).toHaveLength(0);
  });

  it('history is limited to 100', () => {
    const { store, clipId } = seeded();
    for (let i = 1; i <= 130; i++) store.getState().apply((d) => moveClip(d, clipId, i, {}));
    expect(store.temporal.getState().pastStates).toHaveLength(100);
  });

  it('replaceDoc clears history', () => {
    const { store, clipId } = seeded();
    store.getState().apply((d) => moveClip(d, clipId, 3, {}));
    store.getState().replaceDoc(emptyTimeline('16:9'));
    expect(store.getState().doc.width).toBe(1920);
    expect(store.temporal.getState().pastStates).toHaveLength(0);
    expect(store.temporal.getState().futureStates).toHaveLength(0);
  });
});

describe('ui store', () => {
  it('has defaults outside the history', () => {
    const ui = createUiStore();
    expect(ui.getState()).toMatchObject({ selected: [], playhead: 0, playing: false, snapLine: null });
    ui.getState().set({ playhead: 2 });
    expect(ui.getState().playhead).toBe(2);
  });
});

describe('rewriteAssetId', () => {
  it('renames a local asset id in the doc and in the whole history without adding a step', () => {
    const r = addClip(emptyTimeline('9:16'), { id: 'local:1', kind: 'image' }, { at: 0 }, () => `x${Math.random()}`);
    const store = createEditorStore(emptyTimeline('9:16'));
    store.getState().apply(() => r.doc);
    store.getState().apply((d) => moveClip(d, r.clipIds[0]!, 2, {}));
    store.getState().rewriteAssetId('local:1', 'real');
    expect(findClip(store.getState().doc, r.clipIds[0]!)!.clip.assetId).toBe('real');
    expect(store.temporal.getState().pastStates).toHaveLength(2);
    store.temporal.getState().undo();
    expect(findClip(store.getState().doc, r.clipIds[0]!)!.clip.assetId).toBe('real');
  });
});
