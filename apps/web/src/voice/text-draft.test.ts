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

describe('createTextDraft: normalize і збереження в процесі', () => {
  const trim = (t: string) => t.trim();

  it('зберігає нормалізований текст; пробіл у кінці не дає окремого збереження', () => {
    const save = vi.fn();
    const d = createTextDraft({ value: 'aerial', save, delayMs: 600, normalize: trim });
    d.change('aerial view ');
    d.flush();
    expect(save).toHaveBeenCalledExactlyOnceWith('aerial view');
    d.change('aerial ');
    d.flush();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith('aerial');
  });

  it('обрізане сервером значення не замінює локальний текст посеред набору', () => {
    const d = createTextDraft({ value: 'aerial', save: vi.fn(), delayMs: 600, normalize: trim });
    d.change('aerial view ');
    d.flush();
    // сервер повернув trim-нутий текст — у полі лишається «aerial view », наступне слово не злипнеться
    expect(d.sync('aerial view')).toBeNull();
    d.change('aerial view of');
    d.flush();
    // чужа зміна підхоплюється як завжди
    expect(d.sync('waterfall')).toBe('waterfall');
  });

  it('поки збереження не завершилось, старий текст із сервера не затирає правку', async () => {
    let resolve!: () => void;
    const save = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    const d = createTextDraft({ value: 'old', save, delayMs: 600 });
    d.change('new');
    d.flush();
    expect(d.pending()).toBe(true);
    // refetch, що почався до збереження
    expect(d.sync('old')).toBeNull();
    resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(d.pending()).toBe(false);
    expect(d.sync('new')).toBe('new');
    expect(d.sync('other')).toBe('other');
  });

  it('невдале збереження теж знімає очікування', async () => {
    let reject!: (e: Error) => void;
    const d = createTextDraft({
      value: 'old',
      save: () => new Promise<void>((_, r) => (reject = r)),
      delayMs: 600,
    });
    d.change('new');
    d.flush();
    reject(new Error('x'));
    await Promise.resolve();
    await Promise.resolve();
    expect(d.pending()).toBe(false);
  });
});
