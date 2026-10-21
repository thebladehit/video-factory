import { describe, expect, it } from 'vitest';
import { emptyTimeline } from '@vf/shared';
import { addClip, findClip, moveClip } from '@vf/timeline';
import { Autosave } from './autosave';
import { bindAutosave } from './mode-sync';
import { createEditorStore, createUiStore, type EditorMode } from './store';

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

const VIEW: EditorMode = { kind: 'language', language: 'en', separated: false };
const SEP: EditorMode = { kind: 'language', language: 'en', separated: true };

describe('editor mode', () => {
  it('starts in edit mode', () => {
    expect(seeded().store.getState().mode).toEqual({ kind: 'edit' });
  });

  it('a non-separated language view is read-only: apply and gestures change nothing', () => {
    const { store, clipId } = seeded();
    const view = store.getState().doc;
    store.getState().switchMode(VIEW, view);
    store.getState().apply((d) => moveClip(d, clipId, 5, {}));
    store.getState().beginGesture();
    store.getState().apply((d) => moveClip(d, clipId, 6, {}));
    store.getState().endGesture();
    expect(store.getState().doc).toBe(view);
    expect(store.temporal.getState().pastStates).toHaveLength(0);
  });

  it('switching mode is not an undo step and clears history', () => {
    const { store, clipId } = seeded();
    store.getState().apply((d) => moveClip(d, clipId, 3, {}));
    expect(store.temporal.getState().pastStates).toHaveLength(1);
    store.getState().switchMode(SEP, emptyTimeline('16:9'));
    expect(store.temporal.getState().pastStates).toHaveLength(0);
    expect(store.getState().mode).toEqual(SEP);
    expect(store.getState().doc.width).toBe(1920);
    store.temporal.getState().undo();
    expect(store.getState().doc.width).toBe(1920);
  });

  it('a separated language is editable with its own history', () => {
    const { store } = seeded();
    const r = addClip(emptyTimeline('9:16'), { id: 'b', kind: 'image' }, { at: 0 }, () => 'lang-clip');
    store.getState().switchMode(SEP, r.doc);
    store.getState().apply((d) => moveClip(d, 'lang-clip', 4, {}));
    expect(startOf(store, 'lang-clip')).toBe(4);
    expect(store.temporal.getState().pastStates).toHaveLength(1);
  });
});

describe('bindAutosave: documents never mix', () => {
  const fakeAutosave = () => {
    const a = new Autosave({ save: async () => ({ version: 1 }), debounceMs: 1e9, onState: () => {}, version: 1 });
    const docs: unknown[] = [];
    a.change = (d) => void docs.push(d);
    return { a, docs };
  };

  it('base edits go to the base autosave only; separated edits to the language one; views to none', () => {
    const { store, clipId } = seeded();
    const base = fakeAutosave();
    const en = fakeAutosave();
    const off = bindAutosave(store, (m) => (m.kind === 'edit' ? base.a : m.separated ? en.a : null));

    store.getState().apply((d) => moveClip(d, clipId, 1, {}));
    const baseDoc = store.getState().doc;
    expect(base.docs).toHaveLength(1);
    expect(en.docs).toHaveLength(0);

    // перемикання (заміна документа) — не зміна користувача
    const langDoc = addClip(emptyTimeline('9:16'), { id: 'b', kind: 'image' }, { at: 0 }, () => 'lc').doc;
    store.getState().switchMode(SEP, langDoc);
    expect(base.docs).toHaveLength(1);
    expect(en.docs).toHaveLength(0);

    store.getState().apply((d) => moveClip(d, 'lc', 2, {}));
    expect(en.docs).toHaveLength(1);
    expect(base.docs).toHaveLength(1);

    store.getState().switchMode(VIEW, langDoc);
    store.getState().apply((d) => moveClip(d, 'lc', 3, {}));
    expect(en.docs).toHaveLength(1);
    expect(base.docs).toHaveLength(1);

    store.getState().switchMode({ kind: 'edit' }, baseDoc);
    expect(base.docs).toHaveLength(1);
    store.getState().apply((d) => moveClip(d, clipId, 4, {}));
    expect(base.docs).toHaveLength(2);
    expect(en.docs).toHaveLength(1);
    off();
  });
});
