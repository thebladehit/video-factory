import { eq } from 'drizzle-orm';
import { userSettings } from '@vf/db';
import { projectVoiceSchema, voiceDefaultsSchema, type ProjectVoice, type VoiceChoice } from '@vf/shared';
import type { AppDeps } from '../../app';
import type { ProjectRow } from '../projects/service';

/** `projects.voice` має DB-замовчування `{}` — завжди проходить через схему. */
export function parseVoice(raw: unknown): ProjectVoice {
  const r = projectVoiceSchema.safeParse(raw);
  return r.success ? r.data : projectVoiceSchema.parse({});
}

export async function userVoiceDefaults(deps: AppDeps, userId: string) {
  const [row] = await deps.db
    .select({ voices: userSettings.voices })
    .from(userSettings)
    .where(eq(userSettings.userId, userId));
  const r = voiceDefaultsSchema.safeParse(row?.voices ?? {});
  return r.success ? r.data : {};
}

/** Голос мови проєкту: вибраний у проєкті, інакше голос користувача за замовчуванням (як у `getVoice`). */
export async function voiceForLanguage(
  deps: AppDeps,
  userId: string,
  p: Pick<ProjectRow, 'voice'>,
  language: string,
): Promise<VoiceChoice | null> {
  return parseVoice(p.voice).languages[language]?.voice ?? (await userVoiceDefaults(deps, userId))[language] ?? null;
}
