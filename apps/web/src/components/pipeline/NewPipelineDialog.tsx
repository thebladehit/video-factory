import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { LANGUAGES, TARGET_SEC, type ModelRef, type VideoFormat, type VoiceChoice } from '@vf/shared';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { VoicePicker, type VoiceValue } from '@/components/voice/VoicePicker';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useTRPC } from '@/lib/trpc';
import {
  addLanguage,
  blockers,
  initialForm,
  onFormatChange,
  removeLanguage,
  setStopAfterScript,
  setBaseLanguage,
  type FormCatalogItem,
  toSettings,
  type PipelineForm,
} from '@/pipeline/settings-form';
import { usePipelineEstimate } from '@/pipeline/use-pipeline';
import { MusicPicker } from './MusicPicker';

const usd = (v: number) => `$${v < 0.01 ? v.toFixed(4) : v.toFixed(2)}`;
const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

export function NewPipelineDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const trpc = useTRPC();
  const catalog = useQuery({ ...trpc.ai.catalog.queryOptions(), enabled: open });
  const settings = useQuery({ ...trpc.settings.get.queryOptions(), enabled: open });
  const ready = !!catalog.data && !!settings.data;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        {ready ? (
          <PipelineFormBody catalog={catalog.data} settings={settings.data} onClose={() => onOpenChange(false)} />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Відео з теми</DialogTitle>
            </DialogHeader>
            <Loader2 className="mx-auto animate-spin text-muted-foreground" />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PipelineFormBody({
  catalog,
  settings,
  onClose,
}: {
  catalog: FormCatalogItem[];
  settings: {
    defaults: Record<string, { ref: ModelRef; available: boolean } | null>;
    voices: Record<string, VoiceChoice>;
  };
  onClose(): void;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const userVoices = settings.voices;
  const firstAvailable = (cap: string) => catalog.find((m) => m.capability === cap && m.available)?.ref as ModelRef;
  const preferred = (slot: 'text' | 'image') => {
    const d = settings.defaults[slot];
    return d?.available ? d.ref : firstAvailable(slot);
  };
  const [form, setForm] = useState<PipelineForm>(() =>
    initialForm('9:16', { text: preferred('text'), image: preferred('image'), voices: userVoices }),
  );
  const patch = (p: Partial<PipelineForm>) => setForm((f) => ({ ...f, ...p }));

  const { estimate, pending } = usePipelineEstimate(form);
  const reasons = blockers(form, catalog);
  const start = useMutation(
    trpc.pipeline.start.mutationOptions({
      onSuccess: ({ projectId }) => {
        void qc.invalidateQueries({ queryKey: trpc.projects.list.queryKey() });
        onClose();
        void navigate({ to: '/projects/$id/pipeline', params: { id: projectId } });
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const { min, max } = TARGET_SEC[form.format];
  const models = (cap: 'text' | 'image') => catalog.filter((m) => m.capability === cap && m.available);
  const modelSelect = (cap: 'text' | 'image', label: string, value: string, set: (r: ModelRef) => void) => (
    <div className="grid gap-2">
      <Label htmlFor={`pl-${cap}-model`}>{label}</Label>
      <Select value={value} onValueChange={(v) => set(v as ModelRef)}>
        <SelectTrigger id={`pl-${cap}-model`} className="w-full">
          <SelectValue placeholder="Не вибрано">{catalog.find((m) => m.ref === value)?.label ?? value}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {models(cap).map((m) => (
            <SelectItem key={m.ref} value={m.ref}>
              {m.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!reasons.length && !start.isPending) start.mutate(toSettings(form));
      }}
    >
      <DialogHeader>
        <DialogTitle>Відео з теми</DialogTitle>
      </DialogHeader>

      <div className="grid gap-2">
        <Label htmlFor="pl-topic">Тема</Label>
        <Textarea
          id="pl-topic"
          rows={3}
          maxLength={2000}
          value={form.topic}
          placeholder="Про що відео?"
          onChange={(e) => patch({ topic: e.target.value })}
          autoFocus
        />
      </div>

      <div className="grid gap-2">
        <Label>Формат</Label>
        <ToggleGroup
          type="single"
          variant="outline"
          value={form.format}
          onValueChange={(v) => v && setForm((f) => onFormatChange(f, v as VideoFormat))}
          className="justify-start"
        >
          <ToggleGroupItem value="9:16" aria-label="9:16">
            9:16 · Shorts
          </ToggleGroupItem>
          <ToggleGroupItem value="16:9" aria-label="16:9">
            16:9 · YouTube
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="pl-duration">Тривалість: {mmss(form.targetSec)}</Label>
        <input
          id="pl-duration"
          type="range"
          min={min}
          max={max}
          step={form.format === '9:16' ? 5 : 30}
          value={form.targetSec}
          onChange={(e) => patch({ targetSec: Number(e.target.value) })}
        />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="pl-style">Стиль (необов’язково)</Label>
        <Input
          id="pl-style"
          maxLength={1000}
          value={form.style}
          placeholder="Напр.: пізнавально, з гумором"
          onChange={(e) => patch({ style: e.target.value })}
        />
      </div>

      <div className="grid gap-2">
        <Label id="pl-langs">Мови</Label>
        <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby="pl-langs">
          {LANGUAGES.map((l) => {
            const on = form.languages.includes(l.code);
            return (
              <Button
                key={l.code}
                type="button"
                size="sm"
                variant={on ? 'default' : 'outline'}
                aria-pressed={on}
                title={l.name}
                data-testid={`lang-chip-${l.code}`}
                onClick={() => setForm((f) => (on ? removeLanguage(f, l.code) : addLanguage(f, l.code, userVoices)))}
              >
                {l.code.toUpperCase()}
              </Button>
            );
          })}
        </div>
        {form.languages.length > 1 && (
          <div className="flex items-center gap-2">
            <Label htmlFor="pl-base">Базова мова</Label>
            <Select value={form.baseLanguage} onValueChange={(v) => setForm((f) => setBaseLanguage(f, v))}>
              <SelectTrigger id="pl-base" size="sm" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LANGUAGES.filter((l) => form.languages.includes(l.code)).map((l) => (
                  <SelectItem key={l.code} value={l.code}>
                    {l.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      <div className="grid gap-3">
        {form.languages.map((code) => (
          <div key={code} className="grid gap-1" data-testid={`pipeline-voice-${code}`}>
            <span className="text-sm font-medium">Голос: {LANGUAGES.find((l) => l.code === code)?.name ?? code}</span>
            <VoicePicker
              idPrefix={`pl-voice-${code}`}
              language={code}
              value={form.voices[code] ?? null}
              withInstructions={false}
              onChange={(v: VoiceValue | null) =>
                setForm((f) => {
                  const voices = { ...f.voices };
                  if (v) voices[code] = { model: v.model as ModelRef, voiceId: v.voiceId };
                  else delete voices[code];
                  return { ...f, voices };
                })
              }
            />
          </div>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {modelSelect('text', 'Модель тексту', form.textModel, (r) => patch({ textModel: r }))}
        {modelSelect('image', 'Модель зображень', form.imageModel, (r) => patch({ imageModel: r }))}
      </div>

      <div className="grid gap-2">
        <Label>Музика</Label>
        <MusicPicker value={form.musicAssetId} onChange={(id) => patch({ musicAssetId: id })} />
      </div>

      <div className="flex items-center gap-2">
        <input
          id="pl-stop"
          type="checkbox"
          checked={form.stopAfterScript}
          onChange={(e) => setForm((f) => setStopAfterScript(f, e.target.checked))}
        />
        <Label htmlFor="pl-stop">Зупинитися після сценарію</Label>
      </div>

      <DialogFooter className="items-center sm:justify-between">
        <div className="grid gap-0.5 text-sm" data-testid="pipeline-estimate">
          <span>
            Оцінка:{' '}
            {estimate ? (
              estimate.usd === null ? (
                'немає ціни для моделі'
              ) : (
                <b className="tabular-nums">≈ {usd(estimate.usd)}</b>
              )
            ) : (
              '—'
            )}
            {pending && <Loader2 className="ml-1 inline size-3 animate-spin" />}
          </span>
          {reasons.length > 0 && (
            <ul className="text-xs text-destructive" data-testid="pipeline-blockers">
              {reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
        </div>
        <Button type="submit" disabled={reasons.length > 0 || start.isPending}>
          Створити
        </Button>
      </DialogFooter>
    </form>
  );
}
