import type { VoiceView } from '@vf/api';
import { describe, expect, it } from 'vitest';
import { transcribeInput } from './transcribe-input';

const line = (text: string) => ({ id: 'l', text, origin: 'stt' as const, state: 'empty' as const });
const view = (lines: VoiceView['lines'], segments = [{ id: 's1', start: 0, end: 2 }]) => ({
  projectId: 'p1',
  base: 'uk',
  segments,
  lines,
});

describe('transcribeInput', () => {
  it('fresh project (no segments) → no language: auto-detect', () => {
    expect(transcribeInput(view({}, []))).toEqual({ projectId: 'p1' });
  });

  it('segments without base text (or only blank / other-language text) → auto-detect', () => {
    expect(transcribeInput(view({ s1: { uk: line('  '), en: line('Hello') } }))).toEqual({ projectId: 'p1' });
  });

  it('base language has text → recognised in the base language', () => {
    expect(transcribeInput(view({ s1: { uk: line('Привіт') } }))).toEqual({ projectId: 'p1', language: 'uk' });
  });
});
