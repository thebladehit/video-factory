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
const view = (takes: VoiceTake[]) => ({ base: 'uk', baseTakes: takes });
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
