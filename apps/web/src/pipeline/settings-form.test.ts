import type { ModelRef, VoiceChoice } from '@vf/shared';
import { describe, expect, it } from 'vitest';
import { addLanguage, blockers, initialForm, onFormatChange, type FormCatalogItem } from './settings-form';

const TEXT = 'anthropic/claude-sonnet' as ModelRef;
const IMAGE = 'openai/gpt-image' as ModelRef;
const TTS = 'openai/tts' as ModelRef;
const voice = (voiceId: string): VoiceChoice => ({ model: TTS, voiceId });

const catalog: FormCatalogItem[] = [
  { ref: TEXT, label: 'Claude Sonnet', capability: 'text', available: true },
  { ref: IMAGE, label: 'GPT Image', capability: 'image', available: true },
  { ref: TTS, label: 'OpenAI TTS', capability: 'tts', available: true },
];
const defaults = { text: TEXT, image: IMAGE, voices: { uk: voice('a'), en: voice('b') } };

describe('settings-form', () => {
  it('switching 9:16→16:9 moves targetSec 45 to 60 and enables stopAfterScript', () => {
    const form = initialForm('9:16', defaults);
    expect(form.targetSec).toBe(45);
    expect(form.stopAfterScript).toBe(false);
    const next = onFormatChange(form, '16:9');
    expect(next.format).toBe('16:9');
    expect(next.targetSec).toBe(60);
    expect(next.stopAfterScript).toBe(true);
    expect(onFormatChange({ ...next, targetSec: 600 }, '9:16').targetSec).toBe(90);
  });

  it('user-set stopAfterScript survives format change', () => {
    const form = { ...initialForm('9:16', defaults), stopAfterScript: true };
    expect(onFormatChange(form, '16:9').stopAfterScript).toBe(true);
    const wide = { ...initialForm('16:9', defaults), stopAfterScript: false };
    expect(onFormatChange(wide, '9:16').stopAfterScript).toBe(false);
  });

  it('blockers lists missing voice per language and unavailable model', () => {
    let form = { ...initialForm('9:16', defaults), topic: 'Космос' };
    expect(blockers(form, catalog)).toEqual([]);
    form = addLanguage(form, 'de', {});
    form = { ...form, textModel: 'anthropic/gone' as ModelRef };
    const off = catalog.map((m) => (m.ref === IMAGE ? { ...m, available: false } : m));
    const list = blockers(form, off);
    expect(list).toContain('Не вибрано голос для мови «Німецька»');
    expect(list).toContain('Немає ключа для моделі GPT Image');
    expect(list.some((s) => s.includes('anthropic/gone'))).toBe(true);
    expect(blockers({ ...form, topic: 'ab' }, catalog)).toContain('Тема — від 3 символів');
  });

  it('adding a language takes its default voice from user settings', () => {
    const form = initialForm('9:16', defaults);
    expect(form.languages).toEqual(['uk']);
    const next = addLanguage(form, 'en', defaults.voices);
    expect(next.languages).toEqual(['uk', 'en']);
    expect(next.voices.en).toEqual(voice('b'));
    expect(addLanguage(next, 'en', defaults.voices)).toEqual(next);
  });
});
