import type { ModelRef, VoiceChoice } from '@vf/shared';
import { describe, expect, it } from 'vitest';
import {
  addLanguage,
  blockers,
  initialForm,
  onFormatChange,
  setStopAfterScript,
  toSettings,
  type FormCatalogItem,
} from './settings-form';

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

  it('user-set stopAfterScript survives format change and round trips', () => {
    // 9:16: ticked -> 16:9 -> back to 9:16 stays ticked
    const ticked = setStopAfterScript(initialForm('9:16', defaults), true);
    const wide = onFormatChange(ticked, '16:9');
    expect(wide.stopAfterScript).toBe(true);
    expect(onFormatChange(wide, '9:16').stopAfterScript).toBe(true);
    // 16:9: unticked -> 9:16 -> back to 16:9 stays unticked
    const unticked = setStopAfterScript(initialForm('16:9', defaults), false);
    const tall = onFormatChange(unticked, '9:16');
    expect(tall.stopAfterScript).toBe(false);
    expect(onFormatChange(tall, '16:9').stopAfterScript).toBe(false);
  });

  it('explicitly setting the current default still counts as user choice', () => {
    const form = setStopAfterScript(initialForm('9:16', defaults), false); // equals 9:16 default
    expect(onFormatChange(form, '16:9').stopAfterScript).toBe(false);
    const untouched = onFormatChange(onFormatChange(initialForm('9:16', defaults), '16:9'), '9:16');
    expect(untouched.stopAfterScript).toBe(false);
  });

  it('toSettings drops form-only fields', () => {
    expect('stopTouched' in toSettings(initialForm('9:16', defaults))).toBe(false);
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
