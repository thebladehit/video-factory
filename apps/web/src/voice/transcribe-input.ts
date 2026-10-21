import type { VoiceView } from '@vf/api';

/**
 * Запит «Розпізнати мову оригіналу». Поки в базовій мові немає жодного тексту (свіжий проєкт) — без `language`:
 * мову визначає розпізнавання, і задача робить її базовою. Інакше — розпізнавати базовою мовою проєкту.
 */
export function transcribeInput(view: Pick<VoiceView, 'projectId' | 'base' | 'segments' | 'lines'>): {
  projectId: string;
  language?: string;
} {
  const baseHasText = view.segments.some((s) => view.lines[s.id]?.[view.base]?.text.trim());
  return baseHasText ? { projectId: view.projectId, language: view.base } : { projectId: view.projectId };
}
