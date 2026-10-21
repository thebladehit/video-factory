import { describe, expect, it } from 'vitest';
import {
  buildOutlinePrompt,
  buildScenePrompt,
  buildScriptPrompt,
  sceneSchema,
  scenePlan,
  scriptSchema,
  validateScript,
} from './script';

const base = {
  topic: 'Чому небо блакитне',
  targetSec: 45,
  language: 'uk',
  channelStyle: 'Іронічний тон',
  style: 'Без жаргону',
};
const scene = { narration: 'Привіт', visualPrompt: 'sky', keywords: ['sky'] };

describe('scenePlan', () => {
  it('9:16 45s -> 9 scenes, 113 words, one stage', () => {
    expect(scenePlan('9:16', 45)).toEqual({ scenes: 9, words: 113, twoStage: false });
  });
  it('16:9 900s -> 60 scenes, two stages', () => {
    expect(scenePlan('16:9', 900)).toEqual({ scenes: 60, words: 2250, twoStage: true });
  });
  it('clamps to 1..60', () => {
    expect(scenePlan('9:16', 1).scenes).toBe(1);
    expect(scenePlan('9:16', 1000).scenes).toBe(60);
  });
  it('16:9 at exactly 40 scenes is single stage', () => {
    expect(scenePlan('16:9', 600).twoStage).toBe(false);
  });
});

describe('buildScriptPrompt', () => {
  const p9 = buildScriptPrompt({ ...base, format: '9:16' });
  it('9:16 asks for a hook in the first scene and no greeting', () => {
    expect(p9.system).toMatch(/хук/i);
    expect(p9.system).toMatch(/без вступу-привітання/i);
  });
  it('16:9 asks for intro, sections, conclusion', () => {
    const p = buildScriptPrompt({ ...base, format: '16:9', targetSec: 300 });
    expect(p.system).toMatch(/вступ/i);
    expect(p.system).toMatch(/розділ/i);
    expect(p.system).toMatch(/висновок/i);
  });
  it('channel style and run style go into system', () => {
    expect(p9.system).toContain('Іронічний тон');
    expect(p9.system).toContain('Без жаргону');
  });
  it('names the narration language and asks for English visual prompts', () => {
    expect(p9.system).toContain('Українська');
    expect(p9.system).toMatch(/visualPrompt[^.]*англійськ/);
  });
  it('has markers for the fake provider', () => {
    expect(p9.prompt).toContain('Кількість сцен: 9');
    expect(p9.prompt).toContain('Мова: uk');
    expect(p9.prompt).toContain('Тема: Чому небо блакитне');
  });
  it('retry prompt lists errors', () => {
    const p = buildScriptPrompt({ ...base, format: '9:16', errors: ['Сцена 2: порожній visualPrompt'] });
    expect(p.prompt).toContain('Сцена 2: порожній visualPrompt');
  });
  it('section prompt carries section and previous scenes, plan from section seconds', () => {
    const p = buildScriptPrompt({
      ...base,
      format: '16:9',
      targetSec: 900,
      section: { title: 'Розділ А', summary: 'про А', sec: 150, previous: ['Попередня сцена'] },
    });
    expect(p.prompt).toContain('Кількість сцен: 10');
    expect(p.prompt).toContain('Розділ А');
    expect(p.prompt).toContain('Попередня сцена');
  });
});

describe('outline and scene prompts', () => {
  it('outline prompt carries duration marker and style', () => {
    const p = buildOutlinePrompt({ ...base, targetSec: 900 });
    expect(p.prompt).toContain('Тривалість: 900');
    expect(p.prompt).toContain('Мова: uk');
    expect(p.system).toContain('Іронічний тон');
  });
  it('scene prompt carries current/neighbours', () => {
    const p = buildScenePrompt({ ...base, format: '9:16', previous: 'ПРЕД', next: 'НАСТ', current: 'ПОТОЧНА' });
    expect(p.prompt).toContain('Поточна сцена: ПОТОЧНА');
    expect(p.prompt).toContain('ПРЕД');
    expect(p.prompt).toContain('НАСТ');
  });
});

describe('validateScript', () => {
  const ok = { title: 't', scenes: [scene] };
  it('valid script gives no errors', () => expect(validateScript(ok, { scenes: 1 })).toEqual([]));
  it('flags narration > 1500, empty visualPrompt, 0 or 9 keywords', () => {
    const errs = validateScript(
      {
        title: 't',
        scenes: [
          { ...scene, narration: 'a'.repeat(1501) },
          { ...scene, visualPrompt: ' ' },
          { ...scene, keywords: [] },
          { ...scene, keywords: Array(9).fill('k') },
        ],
      },
      { scenes: 4 },
    );
    expect(errs).toHaveLength(4);
    expect(errs[0]).toContain('Сцена 1');
  });
  it('flags scene count outside 1..60', () => {
    expect(validateScript({ title: 't', scenes: [] }, { scenes: 5 }).length).toBeGreaterThan(0);
    expect(validateScript({ title: 't', scenes: Array(61).fill(scene) }, { scenes: 60 }).length).toBeGreaterThan(0);
  });
});

describe('schemas', () => {
  it('scriptSchema and sceneSchema parse a scene', () => {
    expect(sceneSchema.parse(scene)).toEqual(scene);
    expect(scriptSchema.parse({ title: 't', scenes: [scene] }).scenes).toHaveLength(1);
  });
});
