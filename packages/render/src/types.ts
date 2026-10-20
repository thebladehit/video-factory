import type { TimelineDoc } from '@vf/shared';

export type Preset = 'final' | 'draft';

export interface SourceInfo {
  path: string;
  kind: 'image' | 'video' | 'audio';
  /** Відображувані розміри (з урахуванням повороту) */
  width?: number;
  height?: number;
  hasAudio: boolean;
  /** Каналів у звуковому потоці; моно дублюється в обидва канали на повній гучності */
  audioChannels?: number;
}

export interface CompileInput {
  doc: TimelineDoc;
  preset: Preset;
  sources: Map<string, SourceInfo>;
  /** Точка розширення для підпроєкту 3 (озвучка/субтитри мови); зараз не використовується */
  language?: string | null;
  filterScriptPath: string;
  outPath: string;
}

export interface Compiled {
  args: string[];
  filterScript: string;
  durationSec: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}
