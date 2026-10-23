import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { deliveryFor, type ModelRef } from '@vf/shared';
import { Loader2, Play, Square } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  AUDITION_CONCURRENCY,
  AUDITION_MAX_CHARS,
  AUDITION_TAKES,
  estimateAudition,
  pickCandidates,
  runQueue,
  type AuditionCandidate,
} from '@/voice/audition';
import { formatUsd } from '@/voice/cost';
import { useTRPC } from '@/lib/trpc';

export { AUDITION_CANDIDATES } from '@/voice/audition';

const DEFAULT_PHRASE: Record<string, string> = {
  uk: 'Привіт! Це перевірка голосу для вашого відео: чітко, спокійно й без поспіху.',
  en: 'Hello! This is a voice check for your video: clear, calm and unhurried.',
};

type Take = { state: 'pending' } | { state: 'ready'; url: string } | { state: 'error'; message: string };
const keyOf = (c: AuditionCandidate) => `${c.model}|${c.voiceId}`;

/** «Порівняти голоси»: одна фраза → 2 дублі на кожного відмічено кандидата; ▶, «Зробити типовим». */
export function AuditionDialog({
  language,
  open,
  onOpenChange,
}: {
  language: string;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const catalog = useQuery(trpc.ai.catalog.queryOptions());
  const candidates = useMemo(() => pickCandidates(catalog.data ?? []), [catalog.data]);
  const [phrase, setPhrase] = useState(DEFAULT_PHRASE[language] ?? DEFAULT_PHRASE.en!);
  const [instructions, setInstructions] = useState('');
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [takes, setTakes] = useState<Record<string, Record<number, Take>>>({});
  const [running, setRunning] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const alive = useRef(true);
  /** Номер запуску: закриття діалогу чи новий запуск зупиняє чергу попереднього (платні запити не тривають) */
  const runId = useRef(0);
  /** Останній запущений набір: результати старішого (що ще летіли) не перезаписують дублі нового */
  const lastStart = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      runId.current++;
      audio.current?.pause();
    };
  }, []);
  useEffect(() => {
    if (open) return;
    runId.current++;
    audio.current?.pause();
    setPlaying(null);
    setRunning(false);
    // дублі, які вже не почнуться, не висять «у роботі» при наступному відкритті
    setTakes((p) =>
      Object.fromEntries(
        Object.entries(p).map(([k, t]) => [
          k,
          Object.fromEntries(Object.entries(t).filter(([, v]) => v.state !== 'pending')),
        ]),
      ),
    );
  }, [open]);

  const audition = useMutation(trpc.voice.audition.mutationOptions());
  const makeDefault = useMutation(
    trpc.settings.setVoice.mutationOptions({
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: trpc.settings.get.queryKey() });
        toast.success('Голос стане типовим для цієї мови');
        onOpenChange(false);
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const checked = candidates.filter((c) => !unchecked.has(keyOf(c)));
  const text = phrase.trim();
  const usd = estimateAudition(catalog.data ?? [], checked, text.length);
  const nameOf = (c: AuditionCandidate) => {
    const m = catalog.data?.find((e) => e.ref === c.model);
    return `${m?.label ?? c.model} · ${m?.voices?.find((v) => v.id === c.voiceId)?.name ?? c.voiceId}`;
  };

  const setTake = (c: AuditionCandidate, take: number, v: Take) =>
    alive.current && setTakes((p) => ({ ...p, [keyOf(c)]: { ...p[keyOf(c)], [take]: v } }));

  async function start() {
    const jobs = checked.flatMap((c) =>
      Array.from({ length: AUDITION_TAKES }, (_, i) => ({ c, take: (i + 1) as 1 | 2 })),
    );
    const id = ++runId.current;
    lastStart.current = id;
    setRunning(true);
    setTakes({});
    for (const j of jobs) setTake(j.c, j.take, { state: 'pending' });
    await runQueue(
      jobs,
      AUDITION_CONCURRENCY,
      async ({ c, take }) => {
        try {
          const { url } = await audition.mutateAsync({
            model: c.model as ModelRef,
            voiceId: c.voiceId,
            language,
            text,
            ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
            take,
          });
          if (lastStart.current === id) setTake(c, take, { state: 'ready', url });
        } catch (e) {
          if (lastStart.current === id)
            setTake(c, take, { state: 'error', message: e instanceof Error ? e.message : 'Помилка' });
        }
      },
      { shouldContinue: () => alive.current && runId.current === id },
    );
    if (alive.current && runId.current === id) setRunning(false);
  }

  function play(id: string, url: string) {
    audio.current?.pause();
    if (playing === id) return setPlaying(null);
    const el = new Audio(url);
    el.onended = () => setPlaying(null);
    el.onerror = () => setPlaying(null);
    audio.current = el;
    setPlaying(id);
    void el.play().catch(() => setPlaying(null));
  }

  const toggle = (c: AuditionCandidate, on: boolean) =>
    setUnchecked((p) => {
      const n = new Set(p);
      if (on) n.delete(keyOf(c));
      else n.add(keyOf(c));
      return n;
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" data-testid="audition-dialog">
        <DialogHeader>
          <DialogTitle>Порівняти голоси</DialogTitle>
          <DialogDescription>
            Одна фраза, по два дублі на кожного відміченого кандидата — послухайте й виберіть типовий.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1">
            <Label htmlFor="audition-phrase" className="text-xs text-muted-foreground">
              Фраза (до {AUDITION_MAX_CHARS} символів)
            </Label>
            <Textarea
              id="audition-phrase"
              rows={2}
              maxLength={AUDITION_MAX_CHARS}
              value={phrase}
              className="min-h-0 resize-none text-sm"
              onChange={(e) => setPhrase(e.target.value)}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="audition-instr" className="text-xs text-muted-foreground">
              Інструкції стилю (необов’язково)
            </Label>
            <Textarea
              id="audition-instr"
              rows={2}
              maxLength={1000}
              value={instructions}
              placeholder={deliveryFor(language)}
              className="min-h-0 resize-none text-sm"
              onChange={(e) => setInstructions(e.target.value)}
            />
          </div>
          {candidates.length === 0 && catalog.isSuccess && (
            <p className="text-sm text-muted-foreground">
              Немає доступних моделей озвучки — додайте ключ у налаштуваннях.
            </p>
          )}
          <ul className="grid gap-2">
            {candidates.map((c) => {
              const t = takes[keyOf(c)] ?? {};
              const isOn = !unchecked.has(keyOf(c));
              return (
                <li
                  key={keyOf(c)}
                  className="flex flex-wrap items-center gap-2 rounded-md border p-2"
                  data-testid="audition-candidate"
                  data-voice={c.voiceId}
                >
                  <label className="flex flex-1 items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={isOn}
                      disabled={running}
                      aria-label={`Кандидат ${nameOf(c)}`}
                      onChange={(e) => toggle(c, e.target.checked)}
                    />
                    {nameOf(c)}
                  </label>
                  {[1, 2].map((n) => {
                    const take = t[n];
                    if (!take) return null;
                    const id = `${keyOf(c)}#${n}`;
                    return (
                      <Button
                        key={n}
                        size="sm"
                        variant="outline"
                        data-testid="audition-take"
                        data-state={take.state}
                        disabled={take.state !== 'ready'}
                        title={take.state === 'error' ? take.message : undefined}
                        aria-label={`Дубль ${n}: ${nameOf(c)}`}
                        onClick={() => take.state === 'ready' && play(id, take.url)}
                      >
                        {take.state === 'pending' ? (
                          <Loader2 className="animate-spin" />
                        ) : playing === id ? (
                          <Square />
                        ) : (
                          <Play />
                        )}
                        {take.state === 'error' ? 'Помилка' : `Дубль ${n}`}
                      </Button>
                    );
                  })}
                  {t[1]?.state === 'ready' || t[2]?.state === 'ready' ? (
                    <Button
                      size="sm"
                      disabled={makeDefault.isPending}
                      onClick={() =>
                        makeDefault.mutate({
                          language,
                          voice: {
                            model: c.model,
                            voiceId: c.voiceId,
                            ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
                          },
                        })
                      }
                    >
                      Зробити типовим
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
        <DialogFooter className="items-center sm:justify-between">
          <span className="text-sm text-muted-foreground" data-testid="audition-estimate">
            Оцінка: ≈ {formatUsd(usd)} ({checked.length} × {AUDITION_TAKES} дублі)
          </span>
          <Button disabled={running || checked.length === 0 || !text} onClick={() => void start()}>
            {running && <Loader2 className="animate-spin" />}
            Згенерувати
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
