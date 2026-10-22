import { describe, expect, it } from 'vitest';
import { advance, afterDone, type LangSnap, type RunSnap, type SceneSnap } from './advance';

function run(over: Partial<RunSnap> = {}): RunSnap {
  return {
    stage: 'script',
    status: 'running',
    stopAfterScript: false,
    scriptJob: null,
    assembleJob: null,
    scenesWritten: false,
    scenes: [],
    langs: [],
    ...over,
  };
}

const scene = (id: string, over: Partial<SceneSnap> = {}): SceneSnap => ({
  id,
  status: 'empty',
  hasVisual: false,
  job: null,
  generation: null,
  ...over,
});

const lines = (...statuses: LangSnap['lines'][number]['status'][]) => statuses.map((status) => ({ status, hasText: true }));
const base = (over: Partial<LangSnap> = {}): LangSnap => ({ language: 'uk', isBase: true, translate: 'none', lines: lines('ready'), ...over });
const other = (language: string, over: Partial<LangSnap> = {}): LangSnap => ({
  language,
  isBase: false,
  translate: 'done',
  lines: lines('ready'),
  ...over,
});

/** Етап produce, де все кінцеве: збірка готова до запуску */
const produceDone = (over: Partial<RunSnap> = {}): RunSnap =>
  run({
    stage: 'produce',
    scriptJob: 'done',
    scenesWritten: true,
    scenes: [scene('s1', { status: 'ready', hasVisual: true }), scene('s2', { status: 'ready', hasVisual: true })],
    langs: [base(), other('en')],
    ...over,
  });

describe('advance: status gate', () => {
  it('fresh run → enqueueScript only', () => {
    expect(advance(run())).toEqual([{ type: 'enqueueScript' }]);
  });

  it('awaiting_review → []', () => {
    expect(advance(run({ stage: 'review', status: 'awaiting_review', scriptJob: 'done', scenesWritten: true }))).toEqual([]);
  });

  it('cancelled run → []', () => {
    expect(advance(run({ status: 'cancelled' }))).toEqual([]);
    expect(advance(produceDone({ status: 'cancelled', scenes: [scene('s1')] }))).toEqual([]);
  });

  it('failed run → []', () => {
    expect(advance(run({ status: 'failed', scriptJob: 'failed' }))).toEqual([]);
  });

  it('done run ignores any snapshot (Review Focus 2)', () => {
    const snaps: RunSnap[] = [
      produceDone({ stage: 'done', status: 'done', assembleJob: 'done' }),
      // переозвучка рядка в студії, новий візуал, чужий asset.process після done
      produceDone({
        stage: 'done',
        status: 'done',
        assembleJob: 'done',
        scenes: [
          scene('s1', { status: 'queued', hasVisual: true, generation: { status: 'done', assetId: 'a1', assetStatus: 'ready' } }),
          scene('s2'),
        ],
        langs: [base({ lines: lines('empty', 'queued') }), other('en', { translate: 'none' })],
      }),
      produceDone({ stage: 'assemble', status: 'done', assembleJob: 'failed' }),
    ];
    for (const s of snaps) expect(advance(s)).toEqual([]);
  });

  it('stage done with status running → []', () => {
    expect(advance(produceDone({ stage: 'done', assembleJob: 'done' }))).toEqual([]);
  });
});

describe('advance: script', () => {
  it('script job in flight → []', () => {
    expect(advance(run({ scriptJob: 'queued' }))).toEqual([]);
    expect(advance(run({ scriptJob: 'running' }))).toEqual([]);
  });

  it('script done → toProduce', () => {
    expect(advance(run({ scriptJob: 'done', scenesWritten: true }))).toEqual([{ type: 'toProduce' }]);
  });

  it('script done with stopAfterScript → toReview', () => {
    expect(advance(run({ scriptJob: 'done', scenesWritten: true, stopAfterScript: true }))).toEqual([{ type: 'toReview' }]);
  });

  it('script done without scenes written → [] (waits)', () => {
    expect(advance(run({ scriptJob: 'done', scenesWritten: false }))).toEqual([]);
  });

  it('script failed → markFailed', () => {
    expect(advance(run({ scriptJob: 'failed' }))).toEqual([{ type: 'markFailed', error: 'Не вдалося створити сценарій' }]);
  });

  it('script cancelled → [] (run status handles it)', () => {
    expect(advance(run({ scriptJob: 'cancelled' }))).toEqual([]);
  });
});

describe('advance: produce — scenes', () => {
  const produce = (scenes: SceneSnap[]) =>
    run({ stage: 'produce', scriptJob: 'done', scenesWritten: true, scenes, langs: [base()] });

  it('empty scenes → enqueueVisual in order', () => {
    expect(advance(produce([scene('s1'), scene('s2', { status: 'ready', hasVisual: true }), scene('s3')]))).toEqual([
      { type: 'enqueueVisual', sceneId: 's1' },
      { type: 'enqueueVisual', sceneId: 's3' },
    ]);
  });

  it('queued/running scene with live job and no generation result → []', () => {
    expect(
      advance(produce([scene('s1', { status: 'queued', job: 'queued' }), scene('s2', { status: 'running', job: 'running' })])),
    ).toEqual([]);
    expect(
      advance(
        produce([
          scene('s1', { status: 'running', job: 'running', generation: { status: 'running', assetId: null, assetStatus: null } }),
        ]),
      ),
    ).toEqual([]);
  });

  it('queued/running scene without generation and with dead or missing job → sceneFailed', () => {
    for (const job of [null, 'failed', 'cancelled'] as const) {
      for (const status of ['queued', 'running'] as const) {
        expect(advance(produce([scene('s1', { status, job })]))).toEqual([
          { type: 'sceneFailed', sceneId: 's1', error: 'Задачу візуалу перервано' },
        ]);
      }
    }
  });

  it('generation done without asset → sceneFailed', () => {
    expect(
      advance(produce([scene('s1', { status: 'running', generation: { status: 'done', assetId: null, assetStatus: null } })])),
    ).toEqual([{ type: 'sceneFailed', sceneId: 's1', error: 'Не вдалося згенерувати візуал' }]);
  });

  it('generation done with deleted asset (assetStatus null) → sceneFailed, not linkGenerated', () => {
    expect(
      advance(produce([scene('s1', { status: 'running', generation: { status: 'done', assetId: 'a1', assetStatus: null } })])),
    ).toEqual([{ type: 'sceneFailed', sceneId: 's1', error: 'Не вдалося згенерувати візуал' }]);
  });

  it('generation done with asset not linked → linkGenerated (scene queued or running)', () => {
    for (const status of ['queued', 'running'] as const) {
      expect(
        advance(produce([scene('s1', { status, generation: { status: 'done', assetId: 'a1', assetStatus: 'processing' } })])),
      ).toEqual([{ type: 'linkGenerated', sceneId: 's1', assetId: 'a1' }]);
    }
  });

  it('generation done, asset already ready, not linked → linkGenerated then sceneReady', () => {
    expect(
      advance(produce([scene('s1', { status: 'running', generation: { status: 'done', assetId: 'a1', assetStatus: 'ready' } })])),
    ).toEqual([
      { type: 'linkGenerated', sceneId: 's1', assetId: 'a1' },
      { type: 'sceneReady', sceneId: 's1' },
    ]);
  });

  it('linked visual with asset ready → sceneReady', () => {
    for (const status of ['queued', 'running'] as const) {
      expect(
        advance(
          produce([scene('s1', { status, hasVisual: true, generation: { status: 'done', assetId: 'a1', assetStatus: 'ready' } })]),
        ),
      ).toEqual([{ type: 'sceneReady', sceneId: 's1' }]);
    }
  });

  it('linked visual with asset still processing → []', () => {
    expect(
      advance(
        produce([
          scene('s1', { status: 'running', hasVisual: true, generation: { status: 'done', assetId: 'a1', assetStatus: 'processing' } }),
        ]),
      ),
    ).toEqual([]);
  });

  it('generation failed / cancelled / asset failed → sceneFailed', () => {
    const gens = [
      { status: 'failed', assetId: null, assetStatus: null },
      { status: 'cancelled', assetId: null, assetStatus: null },
      { status: 'done', assetId: 'a1', assetStatus: 'failed' },
    ] as const;
    for (const generation of gens) {
      expect(advance(produce([scene('s1', { status: 'running', hasVisual: generation.assetId !== null, generation })]))).toEqual([
        { type: 'sceneFailed', sceneId: 's1', error: 'Не вдалося згенерувати візуал' },
      ]);
    }
  });

  it('ready and failed scenes are terminal, generation ignored', () => {
    expect(
      advance(
        produce([
          scene('s1', { status: 'ready', hasVisual: true, generation: { status: 'done', assetId: 'a1', assetStatus: 'ready' } }),
          scene('s2', { status: 'failed', generation: { status: 'failed', assetId: null, assetStatus: null } }),
          scene('s3', { status: 'failed', generation: { status: 'done', assetId: 'a3', assetStatus: 'ready' } }),
        ]),
      ),
    ).toEqual([{ type: 'enqueueAssemble' }]);
  });
});

describe('advance: produce — languages', () => {
  it('produce with two languages → visuals, synth base, translate en', () => {
    const s = run({
      stage: 'produce',
      scriptJob: 'done',
      scenesWritten: true,
      scenes: [scene('s1'), scene('s2')],
      langs: [base({ lines: lines('empty', 'empty') }), other('en', { translate: 'none', lines: [] })],
    });
    expect(advance(s)).toEqual([
      { type: 'enqueueVisual', sceneId: 's1' },
      { type: 'enqueueVisual', sceneId: 's2' },
      { type: 'enqueueSynthesize', language: 'uk' },
      { type: 'enqueueTranslate', language: 'en' },
    ]);
  });

  it('translate done → synth en (once per language)', () => {
    const s = produceDone({ langs: [base(), other('en', { translate: 'done', lines: lines('empty', 'ready', 'empty') })] });
    expect(advance(s)).toEqual([{ type: 'enqueueSynthesize', language: 'en' }]);
  });

  it('translate live → waits, no synth', () => {
    const s = produceDone({ langs: [base(), other('en', { translate: 'live', lines: lines('empty') })] });
    expect(advance(s)).toEqual([]);
  });

  it('base empty lines without text are terminal and not synthesized', () => {
    const s = produceDone({ langs: [base({ lines: [{ status: 'empty', hasText: false }, { status: 'ready', hasText: true }] })] });
    expect(advance(s)).toEqual([{ type: 'enqueueAssemble' }]);
  });

  it('translated language empty lines without text do not block assemble', () => {
    const s = produceDone({ langs: [base(), other('en', { lines: [{ status: 'empty', hasText: false }] })] });
    expect(advance(s)).toEqual([{ type: 'enqueueAssemble' }]);
  });

  it('base translate field is ignored', () => {
    expect(advance(produceDone({ langs: [base({ translate: 'none' })] }))).toEqual([{ type: 'enqueueAssemble' }]);
  });
});

describe('advance: produce → assemble', () => {
  it('everything terminal → enqueueAssemble', () => {
    expect(advance(produceDone())).toEqual([{ type: 'enqueueAssemble' }]);
  });

  it('failed visual does not block assemble', () => {
    const s = produceDone({ scenes: [scene('s1', { status: 'failed' }), scene('s2', { status: 'ready', hasVisual: true })] });
    expect(advance(s)).toEqual([{ type: 'enqueueAssemble' }]);
  });

  it('failed translate does not block assemble', () => {
    const s = produceDone({ langs: [base(), other('en', { translate: 'failed', lines: [] })] });
    expect(advance(s)).toEqual([{ type: 'enqueueAssemble' }]);
  });

  it('failed lines do not block assemble', () => {
    const s = produceDone({ langs: [base({ lines: lines('failed', 'ready') }), other('en', { lines: lines('failed') })] });
    expect(advance(s)).toEqual([{ type: 'enqueueAssemble' }]);
  });

  it('queued line blocks assemble', () => {
    expect(advance(produceDone({ langs: [base({ lines: lines('ready', 'queued') })] }))).toEqual([]);
    expect(advance(produceDone({ langs: [base(), other('en', { lines: lines('running') })] }))).toEqual([]);
  });

  it('non-terminal scene blocks assemble', () => {
    const s = produceDone({ scenes: [scene('s1', { status: 'running', job: 'running' }), scene('s2', { status: 'ready', hasVisual: true })] });
    expect(advance(s)).toEqual([]);
  });

  it('translate none/live blocks assemble', () => {
    expect(advance(produceDone({ langs: [base(), other('en', { translate: 'live' })] }))).toEqual([]);
    expect(advance(produceDone({ langs: [base(), other('en', { translate: 'none' })] }))).toEqual([
      { type: 'enqueueTranslate', language: 'en' },
    ]);
  });

  it('pending synth action blocks assemble in the same pass', () => {
    expect(advance(produceDone({ langs: [base({ lines: lines('empty', 'ready') })] }))).toEqual([
      { type: 'enqueueSynthesize', language: 'uk' },
    ]);
  });

  it('assemble job exists → no second enqueueAssemble', () => {
    for (const assembleJob of ['queued', 'running', 'done', 'failed', 'cancelled'] as const) {
      expect(advance(produceDone({ assembleJob }))).toEqual([]);
    }
  });
});

describe('advance: assemble', () => {
  const asm = (over: Partial<RunSnap>) => produceDone({ stage: 'assemble', ...over });

  it('assemble done → markDone', () => {
    expect(advance(asm({ assembleJob: 'done' }))).toEqual([{ type: 'markDone' }]);
  });

  it('assemble failed → markFailed', () => {
    expect(advance(asm({ assembleJob: 'failed' }))).toEqual([{ type: 'markFailed', error: 'Не вдалося зібрати відео' }]);
  });

  it('assemble stage without job → enqueueAssemble (heals non-atomic transition)', () => {
    expect(advance(asm({ assembleJob: null }))).toEqual([{ type: 'enqueueAssemble' }]);
  });

  it('assemble in flight / cancelled → []', () => {
    for (const assembleJob of ['queued', 'running', 'cancelled'] as const) {
      expect(advance(asm({ assembleJob }))).toEqual([]);
    }
  });

  it('assemble stage ignores scenes and lines', () => {
    const s = asm({
      assembleJob: 'running',
      scenes: [scene('s1'), scene('s2', { status: 'running', generation: { status: 'done', assetId: 'a2', assetStatus: 'ready' } })],
      langs: [base({ lines: lines('empty') }), other('en', { translate: 'none' })],
    });
    expect(advance(s)).toEqual([]);
  });
});

describe('advance: purity', () => {
  it('same snapshot twice → same actions (pure)', () => {
    const s = run({
      stage: 'produce',
      scriptJob: 'done',
      scenesWritten: true,
      scenes: [
        scene('s1'),
        scene('s2', { status: 'running', generation: { status: 'done', assetId: 'a2', assetStatus: 'ready' } }),
        scene('s3', { status: 'queued', generation: { status: 'failed', assetId: null, assetStatus: null } }),
      ],
      langs: [base({ lines: lines('empty') }), other('en', { translate: 'none' }), other('de', { lines: lines('empty') })],
    });
    const frozen = JSON.stringify(s);
    const first = advance(s);
    expect(advance(s)).toEqual(first);
    expect(JSON.stringify(s)).toBe(frozen);
    expect(first).toEqual([
      { type: 'enqueueVisual', sceneId: 's1' },
      { type: 'linkGenerated', sceneId: 's2', assetId: 'a2' },
      { type: 'sceneReady', sceneId: 's2' },
      { type: 'sceneFailed', sceneId: 's3', error: 'Не вдалося згенерувати візуал' },
      { type: 'enqueueSynthesize', language: 'uk' },
      { type: 'enqueueTranslate', language: 'en' },
      { type: 'enqueueSynthesize', language: 'de' },
    ]);
  });
});

describe('afterDone', () => {
  const done = (scenes: SceneSnap[], over: Partial<RunSnap> = {}) =>
    produceDone({ stage: 'done', status: 'done', assembleJob: 'done', scenes, langs: [base({ lines: lines('empty') })], ...over });

  it('done run: advance stays [] while afterDone links and readies a regenerated scene only', () => {
    const s = done([
      scene('s1', { status: 'ready', hasVisual: true }),
      scene('s2', { status: 'running', generation: { status: 'done', assetId: 'a2', assetStatus: 'ready' } }),
      scene('s3', { status: 'running', generation: { status: 'done', assetId: 'a3', assetStatus: 'processing' } }),
      scene('s4', { status: 'empty' }),
    ]);
    expect(advance(s)).toEqual([]);
    expect(afterDone(s)).toEqual([
      { type: 'linkGenerated', sceneId: 's2', assetId: 'a2' },
      { type: 'sceneReady', sceneId: 's2' },
      { type: 'linkGenerated', sceneId: 's3', assetId: 'a3' },
    ]);
  });

  it('failed generation or interrupted job after done → sceneFailed; nothing live → []', () => {
    const s = done([
      scene('s1', { status: 'running', generation: { status: 'failed', assetId: null, assetStatus: null } }),
      scene('s2', { status: 'queued', job: 'failed' }),
      scene('s3', { status: 'running', job: 'running' }),
    ]);
    expect(afterDone(s)).toEqual([
      { type: 'sceneFailed', sceneId: 's1', error: 'Не вдалося згенерувати візуал' },
      { type: 'sceneFailed', sceneId: 's2', error: 'Задачу візуалу перервано' },
    ]);
    expect(afterDone(done([scene('s1', { status: 'ready', hasVisual: true })]))).toEqual([]);
  });

  it('not done (produce, failed, cancelled) → []', () => {
    const live = [scene('s1', { status: 'running', generation: { status: 'done', assetId: 'a', assetStatus: 'ready' } })];
    expect(afterDone(produceDone({ scenes: live }))).toEqual([]);
    expect(afterDone(done(live, { status: 'failed' }))).toEqual([]);
    expect(afterDone(done(live, { status: 'cancelled' }))).toEqual([]);
  });
});
