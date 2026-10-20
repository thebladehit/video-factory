import { createOpenAI } from '@ai-sdk/openai';
import { createAiSdkTextGen } from './ai-sdk-text';

export const openaiText = (apiKey: string, model: string) => createAiSdkTextGen('openai', createOpenAI({ apiKey })(model));
