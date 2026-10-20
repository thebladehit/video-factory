import { createAnthropic } from '@ai-sdk/anthropic';
import { createAiSdkTextGen } from './ai-sdk-text';

export const anthropicText = (apiKey: string, model: string) => createAiSdkTextGen('anthropic', createAnthropic({ apiKey })(model));
