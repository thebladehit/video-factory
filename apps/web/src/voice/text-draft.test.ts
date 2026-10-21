import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTextDraft } from './text-draft';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createTextDraft', () => {
  it('зберігає після debounce 600 мс', () => {
    const save = vi.fn();
    const d = createTextDraft({ value: 'a', save, delayMs: 600 });
    d.change('ab');
    vi.advanceTimersByTime(599);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(save).toHaveBeenCalledExactlyOnceWith('ab');
  });

  it('flush зберігає одразу, повторний flush — ні', () => {
    const save = vi.fn();
    const d = createTextDraft({ value: 'a', save, delayMs: 600 });
    d.change('ab');
    d.flush();
    d.flush();
    vi.advanceTimersByTime(1000);
    expect(save).toHaveBeenCalledExactlyOnceWith('ab');
  });

  it('повернення до серверного тексту не зберігає', () => {
    const save = vi.fn();
    const d = createTextDraft({ value: 'a', save, delayMs: 600 });
    d.change('ab');
    d.change('a');
    d.flush();
    expect(save).not.toHaveBeenCalled();
    // і далі чужі зміни підхоплюються
    expect(d.sync('z')).toBe('z');
  });

  it('сервер не затирає незбережену правку', () => {
    const d = createTextDraft({ value: 'a', save: vi.fn(), delayMs: 600 });
    d.change('ab');
    expect(d.sync('x')).toBeNull();
  });

  it('перемикання мови: правку A зберігає лише чернетка A, чернетка B показує свій текст', () => {
    const saveEn = vi.fn();
    const saveDe = vi.fn();
    const en = createTextDraft({ value: 'hello', save: saveEn, delayMs: 600 });
    en.change('hello!');
    // key={segment:lang} → розмонтування EN-чернетки, монтування DE
    en.dispose();
    const de = createTextDraft({ value: 'hallo', save: saveDe, delayMs: 600 });
    vi.advanceTimersByTime(2000);
    de.flush();
    expect(saveEn).toHaveBeenCalledExactlyOnceWith('hello!');
    expect(saveDe).not.toHaveBeenCalled();
    expect(de.sync('hallo')).toBe('hallo');
  });
});
