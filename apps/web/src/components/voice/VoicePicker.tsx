import { useMutation, useQuery } from '@tanstack/react-query';
import { deliveryFor, type ModelRef } from '@vf/shared';
import { Loader2, Play, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useTRPC } from '@/lib/trpc';

export interface VoiceValue {
  model: string;
  voiceId: string;
  instructions?: string | undefined;
}

/**
 * Модель озвучки (`ai.catalog`, capability tts), голос моделі, ▶ зразок (`voice.preview`), інструкції стилю.
 * `fallback` — голос за замовчуванням, що діє, поки власний не вибрано.
 */
export function VoicePicker({
  language,
  value,
  fallback,
  withInstructions,
  onChange,
  idPrefix,
}: {
  language: string;
  value: VoiceValue | null;
  fallback?: VoiceValue | null;
  withInstructions: boolean;
  onChange(next: VoiceValue | null): void;
  idPrefix: string;
}) {
  const trpc = useTRPC();
  const catalog = useQuery(trpc.ai.catalog.queryOptions());
  const models = catalog.data?.filter((m) => m.capability === 'tts') ?? [];
  const effective = value ?? fallback ?? null;
  const entry = models.find((m) => m.ref === effective?.model);
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [instructions, setInstructions] = useState(effective?.instructions ?? '');
  useEffect(() => setInstructions(effective?.instructions ?? ''), [effective?.instructions]);
  useEffect(
    () => () => {
      audio.current?.pause();
    },
    [],
  );

  const preview = useMutation(
    trpc.voice.preview.mutationOptions({
      onSuccess: ({ url }) => {
        audio.current?.pause();
        const el = new Audio(url);
        el.onended = () => setPlaying(false);
        el.onerror = () => setPlaying(false);
        audio.current = el;
        setPlaying(true);
        void el.play().catch(() => setPlaying(false));
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  function pickModel(ref: string) {
    const m = models.find((x) => x.ref === ref);
    const first = m?.voices?.[0];
    if (!first) return;
    onChange({
      model: ref,
      voiceId: first.id,
      ...(effective?.instructions ? { instructions: effective.instructions } : {}),
    });
  }

  function togglePlay() {
    if (playing) {
      audio.current?.pause();
      setPlaying(false);
      return;
    }
    if (effective) preview.mutate({ model: effective.model as ModelRef, voiceId: effective.voiceId, language });
  }

  const saveInstructions = () => {
    if (!effective || instructions === (effective.instructions ?? '')) return;
    const next: VoiceValue = { model: effective.model, voiceId: effective.voiceId };
    if (instructions.trim()) next.instructions = instructions;
    onChange(next);
  };

  return (
    <div className="grid gap-2" data-testid="voice-picker" data-language={language}>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={effective?.model ?? ''} onValueChange={pickModel}>
          <SelectTrigger size="sm" className="w-52" aria-label="Модель озвучки" id={`${idPrefix}-model`}>
            <SelectValue placeholder="Модель озвучки">{effective && (entry?.label ?? effective.model)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {models.map((m) => (
              <SelectItem key={m.ref} value={m.ref} disabled={!m.available}>
                {m.label}
                {!m.available && ' — немає ключа'}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={effective?.voiceId ?? ''}
          disabled={!entry}
          onValueChange={(voiceId) =>
            effective &&
            onChange({
              model: effective.model,
              voiceId,
              ...(effective.instructions ? { instructions: effective.instructions } : {}),
            })
          }
        >
          <SelectTrigger size="sm" className="w-36" aria-label="Голос" id={`${idPrefix}-voice`}>
            <SelectValue placeholder="Голос" />
          </SelectTrigger>
          <SelectContent>
            {(entry?.voices ?? []).map((v) => (
              <SelectItem key={v.id} value={v.id}>
                {v.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="icon"
          variant="outline"
          aria-label={playing ? 'Зупинити зразок' : 'Прослухати зразок голосу'}
          data-testid="voice-sample"
          disabled={!effective || !entry?.available || preview.isPending}
          title={effective && entry && !entry.available ? 'Немає ключа моделі' : undefined}
          onClick={togglePlay}
        >
          {preview.isPending ? <Loader2 className="animate-spin" /> : playing ? <Square /> : <Play />}
        </Button>
        {!value && fallback && <span className="text-xs text-muted-foreground">за замовчуванням</span>}
        {value && fallback !== undefined && (
          <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
            Скинути
          </Button>
        )}
      </div>
      {withInstructions && (
        <div className="grid gap-1">
          <Label htmlFor={`${idPrefix}-instr`} className="text-xs text-muted-foreground">
            Інструкції стилю (необов’язково)
          </Label>
          <Textarea
            id={`${idPrefix}-instr`}
            rows={2}
            maxLength={1000}
            disabled={!effective}
            value={instructions}
            placeholder={deliveryFor(language)}
            className="min-h-0 resize-none text-sm"
            onChange={(e) => setInstructions(e.target.value)}
            onBlur={saveInstructions}
          />
          <Button
            size="sm"
            variant="ghost"
            className="justify-self-start"
            disabled={!effective}
            onClick={() => {
              const text = deliveryFor(language);
              setInstructions(text);
              if (effective) onChange({ model: effective.model, voiceId: effective.voiceId, instructions: text });
            }}
          >
            Вставити типову
          </Button>
        </div>
      )}
    </div>
  );
}
