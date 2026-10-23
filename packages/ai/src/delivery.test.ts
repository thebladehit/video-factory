import { describe, expect, it } from 'vitest';
import { DEFAULT_DELIVERY, GEMINI_TTS_TEMPERATURE, deliveryFor } from './delivery';

describe('delivery', () => {
  it('uk and en texts', () => {
    expect(deliveryFor('uk')).toBe(
      'Рівний спокійний голос оповідача. Помірний сталий темп, нейтральна впевнена інтонація, однакова гучність. Без драматизму, шепоту, сміху й різких пауз.',
    );
    expect(deliveryFor('en')).toBe(
      'Steady, calm narrator voice. Moderate consistent pace, neutral confident intonation, even volume. No drama, whispering, laughter or abrupt pauses.',
    );
    expect(Object.keys(DEFAULT_DELIVERY).sort()).toEqual(['en', 'uk']);
    expect(GEMINI_TTS_TEMPERATURE).toBe(0.4);
  });
  it('unknown language falls back to en', () => {
    expect(deliveryFor('de')).toBe(deliveryFor('en'));
  });
});
