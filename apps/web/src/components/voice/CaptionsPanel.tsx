import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { VoiceView } from '@vf/api';
import { languageInfo } from '@vf/shared';
import { Download } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { trpcClient, useTRPC } from '@/lib/trpc';

export const DEFAULT_STYLE_ID = 'preset:shorts';

/** Субтитри мови: перемикач, стиль ▾, «Редагувати стиль», завантаження .srt/.vtt, попередження про приблизні мітки. */
export function CaptionsPanel({
  projectId,
  view,
  lang,
  editing,
  onEditStyle,
  onChanged,
}: {
  projectId: string;
  view: VoiceView;
  lang: string;
  editing: boolean;
  onEditStyle(): void;
  onChanged(): void;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const info = languageInfo(lang);
  const cfg = view.voice.languages[lang]?.captions ?? { enabled: false, styleId: DEFAULT_STYLE_ID };
  const style = view.styles.find((s) => s.id === cfg.styleId) ?? view.styles.find((s) => s.id === DEFAULT_STYLE_ID);
  const set = useMutation(
    trpc.voice.setCaptions.mutationOptions({
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: trpc.voice.get.queryKey({ projectId }) });
        onChanged();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const estimated = view.segments.some((s) => view.lines[s.id]?.[lang]?.timing === 'estimated');
  const presets = view.styles.filter((s) => s.id.startsWith('preset:'));
  const saved = view.styles.filter((s) => !s.id.startsWith('preset:'));

  async function download(format: 'srt' | 'vtt') {
    try {
      const { filename, content } = await trpcClient.voice.subtitles.query({ projectId, language: lang, format });
      const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  if (!info.captions)
    return (
      <p data-testid="captions-unsupported" className="text-xs text-muted-foreground">
        Для мови «{info.name}» немає шрифтів субтитрів — озвучка працює, а субтитри для цієї мови вимкнені.
      </p>
    );

  return (
    <div className="grid gap-2" data-testid="captions-panel">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm">
          <Switch
            aria-label="Субтитри мови"
            data-testid="captions-enabled"
            checked={cfg.enabled}
            disabled={set.isPending}
            onCheckedChange={(enabled) => set.mutate({ projectId, language: lang, enabled, styleId: cfg.styleId })}
          />
          Увімкнути
        </label>
        <Select
          value={style?.id ?? ''}
          onValueChange={(styleId) => set.mutate({ projectId, language: lang, enabled: cfg.enabled, styleId })}
        >
          <SelectTrigger size="sm" className="w-48" aria-label="Стиль субтитрів" data-testid="captions-style">
            <SelectValue placeholder="Стиль" />
          </SelectTrigger>
          <SelectContent>
            {presets.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
            {saved.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" variant="outline" data-testid="edit-style" disabled={editing || !style} onClick={onEditStyle}>
          Редагувати стиль
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost" data-testid="download-subtitles">
              <Download /> Субтитри файлом
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => void download('srt')}>Завантажити .srt</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void download('vtt')}>Завантажити .vtt</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {estimated && (
        <p data-testid="estimated-warning" className="text-xs text-amber-700 dark:text-amber-500">
          Мітки слів приблизні: додайте ключ OpenAI
        </p>
      )}
    </div>
  );
}
