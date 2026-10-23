import { describe, expect, it } from 'vitest';
import { emptyTimeline, type AudioClip, type TimelineDoc } from '@vf/shared';
import { LEAD, quantize, voiceTrackOf, type VoiceTake } from '@vf/timeline';
import { createEditorStore } from './store';
import { createVoiceSync, takesKey, voiceOverflow } from './voice-sync';

const base = (): TimelineDoc => ({
  ...emptyTimeline('9:16'),
  segments: [
    { id: 's1', start: 0, end: 3 },
    { id: 's2', start: 3, end: 6 },
  ],
});
const take = (segmentId: string, durationSec = 2, assetId = `v-${segmentId}`): VoiceTake => ({
  segmentId,
  assetId,
  durationSec,
  transcriptId: `t-${segmentId}`,
});
const view = (takes: VoiceTake[], pending: string[] = []) => ({ base: 'uk', baseTakes: takes, basePending: pending });
const voiceClips = (doc: TimelineDoc) => (voiceTrackOf(doc, 'uk')?.clips ?? []) as AudioClip[];

describe('takesKey', () => {
  it('is segmentId:assetId in the given (segment) order', () => {
    expect(takesKey([take('s1'), take('s2', 1, 'x')])).toBe('s1:v-s1|s2:x');
    expect(takesKey([])).toBe('');
  });
});

describe('createVoiceSync', () => {
  it('applies sync once per takes key', () => {
    const store = createEditorStore(base());
    const sync = createVoiceSync();
    sync.run(store, view([take('s1')]));
    expect(voiceClips(store.getState().doc).map((c) => c.sceneId)).toEqual(['s1']);
    expect(store.temporal.getState().pastStates).toHaveLength(1);
    // той самий набір дублів (новий об'єкт відповіді) — нічого не застосовується
    sync.run(store, view([take('s1')]));
    expect(store.temporal.getState().pastStates).toHaveLength(1);
  });

  it('undo after sync and same takes → not re-applied', () => {
    const store = createEditorStore(base());
    const sync = createVoiceSync();
    sync.run(store, view([take('s1')]));
    store.temporal.getState().undo();
    expect(voiceTrackOf(store.getState().doc, 'uk')).toBeNull();
    sync.run(store, view([take('s1')]));
    expect(voiceTrackOf(store.getState().doc, 'uk')).toBeNull();
    expect(store.temporal.getState().futureStates).toHaveLength(1);
  });

  it('new takes after undo → applied', () => {
    const store = createEditorStore(base());
    const sync = createVoiceSync();
    sync.run(store, view([take('s1')]));
    store.temporal.getState().undo();
    sync.run(store, view([take('s1'), take('s2', 1.5)]));
    expect(voiceClips(store.getState().doc).map((c) => c.sceneId)).toEqual(['s1', 's2']);
    expect(voiceClips(store.getState().doc)[1]).toMatchObject({ start: quantize(3 + LEAD, 30), duration: 1.5 });
  });

  it('skips in language mode and when frozen', () => {
    const store = createEditorStore(base());
    const sync = createVoiceSync();
    store.getState().switchMode({ kind: 'language', language: 'en', separated: true }, base());
    sync.run(store, view([take('s1')]));
    expect(voiceTrackOf(store.getState().doc, 'uk')).toBeNull();

    store.getState().switchMode({ kind: 'edit' }, base());
    store.getState().setFrozen(true);
    sync.run(store, view([take('s1')]));
    expect(voiceTrackOf(store.getState().doc, 'uk')).toBeNull();

    store.getState().setLocked(true);
    store.getState().setFrozen(false);
    sync.run(store, view([take('s1')]));
    expect(voiceTrackOf(store.getState().doc, 'uk')).toBeNull();

    // пропущений набір не запам'ятовується: після розморожування — застосовується
    store.getState().setLocked(false);
    sync.run(store, view([take('s1')]));
    expect(voiceClips(store.getState().doc).map((c) => c.sceneId)).toEqual(['s1']);
  });

  it('sync during open gesture is skipped and applied after gesture ends', () => {
    const store = createEditorStore(base());
    const sync = createVoiceSync();
    const start = store.getState().doc;
    store.getState().beginGesture();
    sync.run(store, view([take('s1')]));
    expect(voiceTrackOf(store.getState().doc, 'uk')).toBeNull();
    // жест перебудовує документ зі стану до жесту (як Timeline/SegmentStrip на кожен рух)
    store.getState().apply(() => ({ ...start, segments: [...start.segments!] }));
    store.getState().endGesture();
    expect(store.getState().gesturing).toBe(false);
    sync.run(store, view([take('s1')]));
    expect(voiceClips(store.getState().doc).map((c) => c.sceneId)).toEqual(['s1']);
  });

  it('reset() makes the same takes apply again (conflict reload)', () => {
    const store = createEditorStore(base());
    const sync = createVoiceSync();
    sync.run(store, view([take('s1')]));
    // «Перезавантажити»: серверний документ без доріжки
    store.getState().switchMode({ kind: 'edit' }, base());
    sync.run(store, view([take('s1')]));
    expect(voiceTrackOf(store.getState().doc, 'uk')).toBeNull();
    sync.reset();
    sync.run(store, view([take('s1')]));
    expect(voiceClips(store.getState().doc).map((c) => c.sceneId)).toEqual(['s1']);
  });

  it('re-voice: a pending line keeps the moved clip; ready → new take at the same start and volume', () => {
    const store = createEditorStore(base());
    const sync = createVoiceSync();
    sync.run(store, view([take('s1'), take('s2')]));
    // користувач зсуває й притишує кліп s1
    store.getState().apply((d) => ({
      ...d,
      tracks: d.tracks.map((t) =>
        t.kind === 'audio'
          ? { ...t, clips: t.clips.map((c) => (c.sceneId === 's1' ? { ...c, start: 0.9, volume: 0.4 } : c)) }
          : t,
      ),
    }));
    const past = store.temporal.getState().pastStates.length;
    // переозвучка s1 у черзі: дубля немає, рядок pending — кліп лишається, кроку історії немає
    sync.run(store, view([take('s2')], ['s1']));
    expect(voiceClips(store.getState().doc).find((c) => c.sceneId === 's1')).toMatchObject({ start: 0.9, volume: 0.4 });
    expect(store.temporal.getState().pastStates).toHaveLength(past);
    // готово: новий дубль на тому ж місці
    sync.run(store, view([take('s1', 1.2, 'new'), take('s2')]));
    expect(voiceClips(store.getState().doc).find((c) => c.sceneId === 's1')).toMatchObject({
      assetId: 'new',
      start: 0.9,
      volume: 0.4,
      duration: 1.2,
    });
  });

  it('the pending set is part of the key: pending → removed (cleared text) re-syncs with the same takes', () => {
    const store = createEditorStore(base());
    const sync = createVoiceSync();
    sync.run(store, view([take('s1'), take('s2')]));
    sync.run(store, view([take('s2')], ['s1']));
    expect(voiceClips(store.getState().doc).map((c) => c.sceneId)).toEqual(['s1', 's2']);
    // текст очищено: ні дубля, ні pending → кліп прибирається
    sync.run(store, view([take('s2')]));
    expect(voiceClips(store.getState().doc).map((c) => c.sceneId)).toEqual(['s2']);
  });

  it('no view → nothing happens', () => {
    const store = createEditorStore(base());
    createVoiceSync().run(store, undefined);
    expect(store.temporal.getState().pastStates).toHaveLength(0);
  });
});

describe('voiceOverflow', () => {
  it('voiceOverflow reports clip longer than its segment', () => {
    const store = createEditorStore(base());
    createVoiceSync().run(store, view([take('s1', 4), take('s2', 1)]));
    const doc = store.getState().doc;
    const [c1, c2] = voiceClips(doc);
    const over = voiceOverflow(doc, 'uk');
    expect([...over.keys()]).toEqual([c1!.id]);
    expect(over.get(c1!.id)).toBeCloseTo(c1!.start + 4 - 3, 6);
    expect(over.has(c2!.id)).toBe(false);
    expect(voiceOverflow(doc, 'en').size).toBe(0);
  });
});
