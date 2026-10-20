import type { ProviderId } from '@vf/shared';

export interface CredentialStore {
  get(userId: string, provider: ProviderId): Promise<string | null>;
}

const ENV_KEYS: Record<Exclude<ProviderId, 'fake'>, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
};

/** Зараз ключі з .env; для SaaS — зашифровані ключі користувачів (BYOK) за тим самим інтерфейсом. */
export function createEnvCredentialStore(env: NodeJS.ProcessEnv): CredentialStore {
  return {
    async get(_userId, provider) {
      if (provider === 'fake') return env.AI_FAKE === '1' ? 'fake' : null;
      return env[ENV_KEYS[provider]]?.trim() || null;
    },
  };
}
