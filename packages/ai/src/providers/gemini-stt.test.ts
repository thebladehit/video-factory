import { describe, expect, it } from 'vitest';
import type { TextGen } from '../types';
import { createGeminiStt, sttSchema } from './gemini-stt';

describe('Gemini STT', () => {
  it('asks generateObject for segments with the audio as a file and builds text', async () => {
    let seen: Parameters<TextGen['generateObject']>[1] | undefined;
    let schema: unknown;
    const textGen: TextGen = {
      generateText: async () => '',
      generateObject: (async (s: unknown, req: Parameters<TextGen['generateObject']>[1]) => {
        schema = s;
        seen = req;
        return {
          language: 'uk',
          segments: [
            { start: 0, end: 1.2, text: 'Привіт' },
            { start: 2, end: 3, text: 'світ' },
          ],
        };
      }) as TextGen['generateObject'],
    };
    const res = await createGeminiStt(textGen).transcribe({
      audio: new Uint8Array([1, 2]),
      mime: 'audio/wav',
      language: 'uk',
      prompt: 'терміни',
    });
    expect(schema).toBe(sttSchema);
    expect(seen!.images?.[0]).toMatchObject({ mime: 'audio/wav' });
    expect(seen!.prompt).toContain('uk');
    expect(seen!.prompt).toContain('терміни');
    expect(res).toEqual({
      text: 'Привіт світ',
      language: 'uk',
      segments: [
        { start: 0, end: 1.2, text: 'Привіт' },
        { start: 2, end: 3, text: 'світ' },
      ],
    });
    expect(res.words).toBeUndefined();
  });
});
