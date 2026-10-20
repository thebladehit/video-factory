import type { z } from 'zod';

export interface Word {
  text: string;
  startMs: number;
  endMs: number;
}

export interface GeneratedFile {
  bytes: Uint8Array;
  mime: string;
  width?: number;
  height?: number;
  durationMs?: number;
}

export type Aspect = '9:16' | '16:9' | '1:1';

export interface TextGen {
  generateText(req: {
    prompt: string;
    system?: string;
    maxOutputTokens?: number;
    signal?: AbortSignal;
  }): Promise<string>;
  generateObject<T>(schema: z.ZodType<T>, req: { prompt: string; system?: string; signal?: AbortSignal }): Promise<T>;
}

export interface ImageGen {
  generate(req: { prompt: string; aspect: Aspect; n: number; signal?: AbortSignal }): Promise<GeneratedFile[]>;
}

export interface OpRef {
  id: string;
}
export type OpStatus = { state: 'pending' | 'running'; progress?: number };

/** Генерація відео — довга операція. Реалізації з'являться в підпроєкті 1. */
export interface VideoGen {
  start(req: { prompt: string; image?: GeneratedFile; aspect: Aspect; durationSec: number }): Promise<OpRef>;
  poll(ref: OpRef): Promise<OpStatus | GeneratedFile[]>;
}

export interface TTS {
  listVoices(language?: string): Promise<{ id: string; name: string; language: string }[]>;
  synthesize(req: { text: string; voiceId: string; language: string; speed?: number }): Promise<{
    audio: GeneratedFile;
    words?: Word[];
  }>;
}

export interface STT {
  transcribe(req: { audio: Uint8Array; mime: string; language?: string }): Promise<{ text: string; words: Word[] }>;
}
