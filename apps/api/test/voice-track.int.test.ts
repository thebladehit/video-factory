import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { jobs, projects, renders } from '@vf/db';
import { normalizeDoc, type TimelineDoc, type VoiceChoice } from '@vf/shared';
import { syncVoiceTrack } from '@vf/timeline';
import { toneMp4Bytes, upload, waitForAsset } from './assets-helpers';
import { startApp } from './helpers';

type Started = Awaited<ReturnType<typeof startApp>>;
const VOICE: VoiceChoice = { model: 'fake/tts', voiceId: 'fake-voice' };

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 60_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - started > timeoutMs) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 100));
  }
}

const voiceClips = (doc: TimelineDoc) =>
  doc.tracks.flatMap((t) => (t.kind === 'audio' && t.role === 'voiceover' ? t.clips : []));

const waitJobs = (s: Started, ids: string[]) =>
  waitFor(async () => {
    const rows = await Promise.all(ids.map(async (id) => (await s.deps.db.select().from(jobs).where(eq(jobs.id, id)))[0]!));
    return rows.every((j) => ['done', 'failed', 'cancelled'].includes(j.status)) && rows;
  });

/** Відео 4 с, сегменти s1 [0,2] і s2 [2,4], база uk; озвучено лише s1. */
async function project(s: Started) {
  const video = await upload(s.caller, 'v.mp4', 'video/mp4', await toneMp4Bytes(4));
  await waitForAsset(s.deps, video, ['ready']);
  const { projectId } = await s.caller.voice.createFromAsset({ assetId: video });
  const p = await s.caller.projects.get({ id: projectId });
  const base: TimelineDoc = {
    ...p.timeline,
    segments: [
      { id: 's1', start: 0, end: 2 },
      { id: 's2', start: 2, end: 4 },
    ],
  };
  const { version } = await s.caller.projects.save({ id: projectId, timeline: base, baseVersion: p.version });
  await s.caller.voice.setLanguages({ projectId, base: 'uk', languages: ['uk'] });
  await s.caller.voice.setVoice({ projectId, language: 'uk', voice: VOICE });
  await synth(s, projectId, 's1', 'Привіт');
  return { projectId, version };
}

async function synth(s: Started, projectId: string, segmentId: string, text: string) {
  await s.caller.voice.setText({ projectId, segmentId, language: 'uk', text });
  const { jobIds } = await s.caller.voice.synthesize({ projectId, language: 'uk' });
  const done = await waitJobs(s, jobIds);
  expect(done.every((j) => j.status === 'done')).toBe(true);
}

const renderDoc = async (s: Started, renderId: string) =>
  normalizeDoc((await s.deps.db.select().from(renders).where(eq(renders.id, renderId)))[0]!.timelineSnapshot);

describe('render of the edit document', () => {
  it('render without language syncs voice on a copy: render snapshot has new take, projects.timeline unchanged', async () => {
    const s = await startApp();
    const { projectId, version } = await project(s);
    const before = (await s.deps.db.select().from(projects).where(eq(projects.id, projectId)))[0]!;
    expect(voiceClips(normalizeDoc(before.timeline))).toHaveLength(0);

    const { renderId } = await s.caller.renders.start({ projectId, preset: 'draft', version });
    const snap = voiceClips(await renderDoc(s, renderId));
    expect(snap.map((c) => c.sceneId)).toEqual(['s1']);

    const after = (await s.deps.db.select().from(projects).where(eq(projects.id, projectId)))[0]!;
    expect(after.timeline).toEqual(before.timeline);
    expect(after.timelineVersion).toBe(version);
  }, 90_000);

  it('render without language keeps user-moved clip position', async () => {
    const s = await startApp();
    const { projectId, version } = await project(s);
    const { baseTakes } = await s.caller.voice.get({ projectId });
    const base = (await s.caller.projects.get({ id: projectId })).timeline;
    const synced = syncVoiceTrack(base, { language: 'uk', takes: baseTakes }).doc;
    const moved: TimelineDoc = {
      ...synced,
      tracks: synced.tracks.map((t) =>
        t.kind === 'audio' && t.role === 'voiceover' ? { ...t, clips: t.clips.map((c) => ({ ...c, start: 1 })) } : t,
      ),
    };
    const saved = await s.caller.projects.save({ id: projectId, timeline: moved, baseVersion: version });
    const { renderId } = await s.caller.renders.start({ projectId, preset: 'draft', version: saved.version });
    expect(voiceClips(await renderDoc(s, renderId)).map((c) => [c.sceneId, c.start])).toEqual([['s1', 1]]);
  }, 90_000);
});
