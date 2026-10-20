import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createAiSdkTextGen } from './ai-sdk-text';

export const googleText = (apiKey: string, model: string) =>
  createAiSdkTextGen('google', createGoogleGenerativeAI({ apiKey })(model));
