import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOCAL_USER_ID } from '@vf/shared';
import {
  assets,
  createDb,
  jobs,
  pipelineRuns,
  pipelineScenes,
  projectLanguageTimelines,
  projects,
  publications,
  renders,
  runMigrations,
  seed,
  socialAccounts,
  transcripts,
  users,
  voiceLines,
} from './index';

const url = process.env.TEST_DATABASE_URL!;
const { db, close } = createDb(url);

beforeAll(async () => {
  await runMigrations(url);
  await seed(db);
  await seed(db);
});
afterAll(() => close());

describe('db', () => {
  it('seed is idempotent and creates the local user', async () => {
    const rows = await db.select().from(users);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(LOCAL_USER_ID);
  });

  it('jobs.status check constraint rejects unknown status', async () => {
    await expect(
      db.insert(jobs).values({ userId: LOCAL_USER_ID, type: 'debug.sleep', payload: {}, status: 'weird' as never }),
    ).rejects.toThrow();
  });

  describe('assets search', () => {
    let id: string;
    beforeAll(async () => {
      const [row] = await db
        .insert(assets)
        .values({
          userId: LOCAL_USER_ID,
          kind: 'image',
          source: 'generated',
          storageKey: `test/${crypto.randomUUID()}.png`,
          mime: 'image/png',
          title: 'Захід сонця над морем',
          tags: ['beach', 'sunset'],
          prompt: 'golden hour ocean',
        })
        .returning({ id: assets.id });
      id = row!.id;
    });
    afterAll(() => db.delete(assets).where(sql`${assets.id} = ${id}`));

    const search = (q: string) =>
      db
        .select({ id: assets.id })
        .from(assets)
        .where(sql`${assets.search} @@ websearch_to_tsquery('simple', ${q}) and ${assets.id} = ${id}`);

    it.each(['sunset', 'Захід', 'ocean'])('full-text finds by %s', async (q) => {
      expect(await search(q)).toHaveLength(1);
    });

    it('full-text does not match unrelated word', async () => {
      expect(await search('mountain')).toHaveLength(0);
    });

    it('trigram matches a misspelled title', async () => {
      const rows = await db.execute<{ s: number }>(
        sql`select similarity(${assets.title}, 'Захид сонця') as s from ${assets} where ${assets.id} = ${id}`,
      );
      expect(Number(rows[0]!.s)).toBeGreaterThan(0.3);
    });
  });

  describe('library columns', () => {
    const base = () => ({
      userId: LOCAL_USER_ID,
      kind: 'image' as const,
      source: 'uploaded' as const,
      storageKey: `test/${crypto.randomUUID()}.png`,
      mime: 'image/png',
    });

    it('asset status defaults to ready and rejects unknown values', async () => {
      const [row] = await db.insert(assets).values(base()).returning();
      expect(row!.status).toBe('ready');
      await expect(db.insert(assets).values({ ...base(), status: 'bogus' as never })).rejects.toThrow();
      await db.delete(assets).where(sql`${assets.id} = ${row!.id}`);
    });

    it('trigram on tags finds a typo', async () => {
      const [row] = await db
        .insert(assets)
        .values({ ...base(), tags: ['котик'] })
        .returning();
      const found = await db
        .select({ id: assets.id })
        .from(assets)
        .where(sql`similarity(vf_tags_text(${assets.tags}), 'котк') > 0.3`);
      expect(found.map((r) => r.id)).toContain(row!.id);
      await db.delete(assets).where(sql`${assets.id} = ${row!.id}`);
    });
  });

  describe('voice tables', () => {
    const asset = async () => {
      const [row] = await db
        .insert(assets)
        .values({
          userId: LOCAL_USER_ID,
          kind: 'audio',
          source: 'generated',
          storageKey: `test/${crypto.randomUUID()}.wav`,
          mime: 'audio/wav',
        })
        .returning();
      return row!;
    };
    const project = async () => {
      const [row] = await db
        .insert(projects)
        .values({
          userId: LOCAL_USER_ID,
          title: 'voice test',
          format: '9:16',
          timeline: { schemaVersion: 1 } as never,
        })
        .returning();
      return row!;
    };
    const line = (projectId: string, over: Partial<typeof voiceLines.$inferInsert> = {}) => ({
      userId: LOCAL_USER_ID,
      projectId,
      segmentId: 'seg-1',
      language: 'en',
      ...over,
    });

    it('projects.voice defaults to {} and voice_lines are unique per (project, segment, language)', async () => {
      const p = await project();
      expect(p.voice).toEqual({});
      await db.insert(voiceLines).values(line(p.id));
      await expect(db.insert(voiceLines).values(line(p.id))).rejects.toThrow();
      await db.insert(voiceLines).values(line(p.id, { language: 'de' }));
      await db.delete(projects).where(sql`${projects.id} = ${p.id}`);
    });

    it('deleting the voice asset nulls audio_asset_id', async () => {
      const p = await project();
      const a = await asset();
      const [row] = await db
        .insert(voiceLines)
        .values(line(p.id, { audioAssetId: a.id, status: 'ready' }))
        .returning();
      await db.delete(assets).where(sql`${assets.id} = ${a.id}`);
      const [after] = await db.select().from(voiceLines).where(sql`${voiceLines.id} = ${row!.id}`);
      expect(after!.audioAssetId).toBeNull();
      await db.delete(projects).where(sql`${projects.id} = ${p.id}`);
    });

    it('deleting the project removes its voice_lines and language timelines', async () => {
      const p = await project();
      await db.insert(voiceLines).values(line(p.id));
      await db
        .insert(projectLanguageTimelines)
        .values({ projectId: p.id, language: 'en', timeline: p.timeline, timelineVersion: 1 });
      await db.delete(projects).where(sql`${projects.id} = ${p.id}`);
      expect(await db.select().from(voiceLines).where(sql`${voiceLines.projectId} = ${p.id}`)).toHaveLength(0);
      expect(
        await db.select().from(projectLanguageTimelines).where(sql`${projectLanguageTimelines.projectId} = ${p.id}`),
      ).toHaveLength(0);
    });

    it('deleting an asset removes its transcripts', async () => {
      const a = await asset();
      await db.insert(transcripts).values({
        userId: LOCAL_USER_ID,
        assetId: a.id,
        language: 'en',
        source: 'tts',
        text: 'hi',
        words: [{ text: 'hi', startMs: 0, endMs: 200 }],
        timing: 'estimated',
      });
      await db.delete(assets).where(sql`${assets.id} = ${a.id}`);
      expect(await db.select().from(transcripts).where(sql`${transcripts.assetId} = ${a.id}`)).toHaveLength(0);
    });

    it('check constraints reject unknown statuses, origins, sources and timings', async () => {
      const p = await project();
      await expect(db.insert(voiceLines).values(line(p.id, { status: 'weird' as never }))).rejects.toThrow();
      await expect(db.insert(voiceLines).values(line(p.id, { textOrigin: 'weird' as never }))).rejects.toThrow();
      const a = await asset();
      const t = { userId: LOCAL_USER_ID, assetId: a.id, language: 'en', text: 'x', words: [] };
      await expect(db.insert(transcripts).values({ ...t, source: 'bogus' as never, timing: 'stt' })).rejects.toThrow();
      await expect(db.insert(transcripts).values({ ...t, source: 'stt', timing: 'bogus' as never })).rejects.toThrow();
      await db.delete(assets).where(sql`${assets.id} = ${a.id}`);
      await db.delete(projects).where(sql`${projects.id} = ${p.id}`);
    });
  });
  describe('pipeline tables', () => {
    const project = async () => {
      const [row] = await db
        .insert(projects)
        .values({ userId: LOCAL_USER_ID, title: 'pipeline test', format: '9:16', timeline: { schemaVersion: 1 } as never })
        .returning();
      return row!;
    };
    const run = (projectId: string) => ({
      userId: LOCAL_USER_ID,
      projectId,
      settings: {} as never,
      stage: 'script' as const,
      status: 'running' as const,
    });
    const scene = (runId: string, over: Partial<typeof pipelineScenes.$inferInsert> = {}) => ({
      userId: LOCAL_USER_ID,
      runId,
      segmentId: 'seg-1',
      position: 0,
      ...over,
    });

    it('pipeline_runs unique per project', async () => {
      const p = await project();
      await db.insert(pipelineRuns).values(run(p.id));
      await expect(db.insert(pipelineRuns).values(run(p.id))).rejects.toThrow();
      await db.delete(projects).where(sql`${projects.id} = ${p.id}`);
    });

    it('pipeline_scenes unique (run_id, segment_id)', async () => {
      const p = await project();
      const [r] = await db.insert(pipelineRuns).values(run(p.id)).returning();
      await db.insert(pipelineScenes).values(scene(r!.id));
      await expect(db.insert(pipelineScenes).values(scene(r!.id))).rejects.toThrow();
      await db.insert(pipelineScenes).values(scene(r!.id, { segmentId: 'seg-2', position: 1 }));
      await expect(db.insert(pipelineScenes).values(scene(r!.id, { segmentId: 's3', status: 'weird' as never }))).rejects.toThrow();
      await expect(db.insert(pipelineScenes).values(scene(r!.id, { segmentId: 's4', visualSource: 'weird' as never }))).rejects.toThrow();
      await db.delete(projects).where(sql`${projects.id} = ${p.id}`);
    });

    it('cascade: deleting project deletes run and scenes', async () => {
      const p = await project();
      const [r] = await db.insert(pipelineRuns).values(run(p.id)).returning();
      await db.insert(pipelineScenes).values(scene(r!.id));
      await db.delete(projects).where(sql`${projects.id} = ${p.id}`);
      expect(await db.select().from(pipelineRuns).where(sql`${pipelineRuns.id} = ${r!.id}`)).toHaveLength(0);
      expect(await db.select().from(pipelineScenes).where(sql`${pipelineScenes.runId} = ${r!.id}`)).toHaveLength(0);
    });

    it('voice_lines accepts text_origin script', async () => {
      const p = await project();
      await db
        .insert(voiceLines)
        .values({ userId: LOCAL_USER_ID, projectId: p.id, segmentId: 's', language: 'uk', textOrigin: 'script' });
      await db.delete(projects).where(sql`${projects.id} = ${p.id}`);
    });

    it('visual_asset_id set null on asset delete', async () => {
      const p = await project();
      const [r] = await db.insert(pipelineRuns).values(run(p.id)).returning();
      const [a] = await db
        .insert(assets)
        .values({ userId: LOCAL_USER_ID, kind: 'image', source: 'generated', storageKey: `test/${crypto.randomUUID()}.png`, mime: 'image/png' })
        .returning();
      const [s] = await db.insert(pipelineScenes).values(scene(r!.id, { visualAssetId: a!.id, visualSource: 'library' })).returning();
      await db.delete(assets).where(sql`${assets.id} = ${a!.id}`);
      const [after] = await db.select().from(pipelineScenes).where(sql`${pipelineScenes.id} = ${s!.id}`);
      expect(after!.visualAssetId).toBeNull();
      await db.delete(projects).where(sql`${projects.id} = ${p.id}`);
    });
  });

  describe('publishing tables', () => {
    it('second live publication for same render+account violates unique; failed one does not', async () => {
      const [p] = await db
        .insert(projects)
        .values({ userId: LOCAL_USER_ID, title: 'publish test', format: '9:16', timeline: { schemaVersion: 1 } as never })
        .returning();
      const [r] = await db
        .insert(renders)
        .values({
          userId: LOCAL_USER_ID,
          projectId: p!.id,
          preset: 'final',
          timelineSnapshot: { schemaVersion: 1 } as never,
          timelineVersion: 1,
        })
        .returning();
      const [acc] = await db
        .insert(socialAccounts)
        .values({ userId: LOCAL_USER_ID, platform: 'youtube', method: 'manual', name: 'ch', language: 'uk' })
        .returning();
      const pub = (status: 'scheduled' | 'failed') => ({
        userId: LOCAL_USER_ID,
        projectId: p!.id,
        renderId: r!.id,
        language: 'uk',
        platform: 'youtube' as const,
        accountId: acc!.id,
        method: 'manual' as const,
        status,
        metadata: { title: '', description: '', tags: [] },
      });
      await db.insert(publications).values(pub('scheduled'));
      await expect(db.insert(publications).values(pub('scheduled'))).rejects.toThrow();
      await expect(db.insert(publications).values(pub('failed'))).resolves.toBeDefined();
      await db.delete(projects).where(sql`${projects.id} = ${p!.id}`);
      await db.delete(socialAccounts).where(sql`${socialAccounts.id} = ${acc!.id}`);
    });
  });
});
