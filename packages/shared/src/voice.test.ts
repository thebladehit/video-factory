import { describe, expect, it } from 'vitest';
import { DEFAULT_ORIGINAL, LANGUAGES, languageInfo, projectVoiceSchema, voiceDefaultsSchema } from './index';

describe('projectVoiceSchema', () => {
  it('fills DEFAULT_ORIGINAL for {}', () => {
    expect(projectVoiceSchema.parse({})).toEqual({ languages: {}, original: DEFAULT_ORIGINAL });
    expect(DEFAULT_ORIGINAL).toEqual({ mode: 'duck', level: 0.25, duckLevel: 0.08 });
  });

  it('parses language settings', () => {
    const v = projectVoiceSchema.parse({
      languages: {
        en: { voice: { model: 'openai/tts-1', voiceId: 'alloy' }, captions: { enabled: true, styleId: 'preset:pop' } },
      },
    });
    expect(v.languages.en?.voice?.voiceId).toBe('alloy');
  });

  it('rejects bad model ref and out-of-range level', () => {
    expect(
      projectVoiceSchema.safeParse({
        languages: { en: { voice: { model: 'nope', voiceId: 'a' }, captions: { enabled: true, styleId: 's' } } },
      }).success,
    ).toBe(false);
    expect(projectVoiceSchema.safeParse({ original: { mode: 'duck', level: 3, duckLevel: 0 } }).success).toBe(false);
  });
});

describe('voiceDefaultsSchema', () => {
  it('parses per-language defaults', () => {
    expect(voiceDefaultsSchema.parse({ uk: { model: 'google/gemini-tts', voiceId: 'Kore' } }).uk?.voiceId).toBe('Kore');
    expect(voiceDefaultsSchema.parse({})).toEqual({});
  });
});

describe('languages', () => {
  it('has the expected set', () => {
    expect(LANGUAGES.map((l) => l.code)).toEqual('uk en es de fr it pt pl nl cs ro tr sv ru kk'.split(' '));
  });
  it('languageInfo', () => {
    expect(languageInfo('uk').captions).toBe(true);
    expect(() => languageInfo('xx')).toThrow(expect.objectContaining({ code: 'VALIDATION' }));
  });
});
