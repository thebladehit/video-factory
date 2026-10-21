import type { ProviderId, Word } from '@vf/shared';
import type { z } from 'zod';

export type { Word };

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
  generateObject<T>(
    schema: z.ZodType<T>,
    req: {
      prompt: string;
      system?: string;
      signal?: AbortSignal;
      /** Зображення для vision-моделей (напр. мініатюра для тегів) */
      images?: GeneratedFile[];
      onUsage?: (u: { inputTokens: number; outputTokens: number }) => void;
    },
  ): Promise<T>;
}

export interface ImageGen {
  generate(req: { prompt: string; aspect: Aspect; n: number; signal?: AbortSignal }): Promise<GeneratedFile[]>;
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Операція провайдера — серіалізується в generations.provider_op, щоб після рестарту продовжити опитування */
export interface OpRef {
  provider: ProviderId;
  data: JsonValue;
}
export type OpStatus = { state: 'pending' | 'running'; progress?: number } | { state: 'failed'; error: string };

/** Генерація відео — довга операція: start одразу повертає OpRef, poll — стан або готові файли. */
export interface VideoGen {
  start(req: { prompt: string; aspect: Aspect; durationSec?: number; signal?: AbortSignal }): Promise<OpRef>;
  poll(ref: OpRef, opts?: { signal?: AbortSignal }): Promise<OpStatus | GeneratedFile[]>;
}

/** Максимум символів на один рядок озвучки (більше — VALIDATION, «розділіть сегмент») */
export const TTS_MAX_CHARS = 1500;

export interface TTS {
  synthesize(req: {
    text: string;
    voiceId: string;
    language: string;
    instructions?: string;
    signal?: AbortSignal;
  }): Promise<{ audio: GeneratedFile; words?: Word[] }>;
}

/** Фраза розпізнавання; час у секундах */
export interface SttSegment {
  start: number;
  end: number;
  text: string;
}

export interface STT {
  transcribe(req: {
    audio: Uint8Array;
    mime: string;
    language?: string;
    prompt?: string;
    signal?: AbortSignal;
  }): Promise<{ text: string; language?: string; segments: SttSegment[]; words?: Word[] }>;
}
