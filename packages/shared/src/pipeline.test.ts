import { describe, expect, it } from 'vitest';
import { defaultPipelineSettings, jobSubject, pipelineSettingsSchema } from './index';

const voice = { model: 'openai/tts-1' as const, voiceId: 'alloy' };
const defaults = {
  text: 'openai/gpt-4o' as const,
  image: 'openai/gpt-image-1' as const,
  voices: { uk: voice, en: voice },
};
const base = (over: Record<string, unknown> = {}) => ({
  topic: 'Чому небо синє',
  format: '9:16',
  targetSec: 45,
  style: '',
  baseLanguage: 'uk',
  languages: ['uk', 'en'],
  textModel: 'openai/gpt-4o',
  imageModel: 'openai/gpt-image-1',
  voices: { uk: voice, en: voice },
  musicAssetId: null,
  stopAfterScript: false,
  ...over,
});

describe('pipelineSettingsSchema', () => {
  it('accepts defaults for 9:16', () => {
    const d = defaultPipelineSettings('9:16', defaults);
    expect(d.targetSec).toBe(45);
    expect(d.stopAfterScript).toBe(false);
    expect(d.textModel).toBe('openai/gpt-4o');
    expect(pipelineSettingsSchema.safeParse({ ...d, topic: 'Чому небо синє', baseLanguage: 'uk', languages: ['uk', 'en'] }).success).toBe(true);
  });

  it('16:9 defaults stopAfterScript true and targetSec 300', () => {
    const d = defaultPipelineSettings('16:9', defaults);
    expect(d.targetSec).toBe(300);
    expect(d.stopAfterScript).toBe(true);
  });

  it('rejects targetSec 100 for 9:16 and 30 for 16:9', () => {
    expect(pipelineSettingsSchema.safeParse(base({ targetSec: 100 })).success).toBe(false);
    expect(pipelineSettingsSchema.safeParse(base({ format: '16:9', targetSec: 30 })).success).toBe(false);
    expect(pipelineSettingsSchema.safeParse(base({ format: '16:9', targetSec: 300 })).success).toBe(true);
  });

  it('rejects baseLanguage not in languages', () => {
    expect(pipelineSettingsSchema.safeParse(base({ baseLanguage: 'de' })).success).toBe(false);
  });

  it('rejects unknown language and language without voice', () => {
    expect(pipelineSettingsSchema.safeParse(base({ languages: ['uk', 'en', 'de'] })).success).toBe(false);
    expect(pipelineSettingsSchema.safeParse(base({ voices: { uk: voice } })).success).toBe(false);
  });

  it('rejects topic of 2 chars and style of 1001', () => {
    expect(pipelineSettingsSchema.safeParse(base({ topic: 'ab' })).success).toBe(false);
    expect(pipelineSettingsSchema.safeParse(base({ style: 'x'.repeat(1001) })).success).toBe(false);
  });
});

describe('jobSubject', () => {
  it('picks sceneId', () => {
    expect(jobSubject({ sceneId: 's1', projectId: 'p' })).toEqual({ sceneId: 's1', projectId: 'p' });
  });
});
