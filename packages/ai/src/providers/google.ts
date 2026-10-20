import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { CatalogEntry } from '../catalog';
import { createAiSdkImageGen } from './ai-sdk-image';
import { createAiSdkTextGen } from './ai-sdk-text';

export const googleText = (apiKey: string, model: string) =>
  createAiSdkTextGen('google', createGoogleGenerativeAI({ apiKey })(model));

export const googleImage = (apiKey: string, model: string, entry: CatalogEntry) =>
  createAiSdkImageGen('google', createGoogleGenerativeAI({ apiKey }).image(model), entry);
