import { createOpenAI } from '@ai-sdk/openai';
import type { CatalogEntry } from '../catalog';
import { createAiSdkImageGen } from './ai-sdk-image';
import { createAiSdkTextGen } from './ai-sdk-text';

export const openaiText = (apiKey: string, model: string) =>
  createAiSdkTextGen('openai', createOpenAI({ apiKey })(model));

export const openaiImage = (apiKey: string, model: string, entry: CatalogEntry) =>
  createAiSdkImageGen('openai', createOpenAI({ apiKey }).image(model), entry);
