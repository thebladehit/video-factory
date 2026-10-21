import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LANGUAGES } from '@vf/shared';
import { toast } from 'sonner';
import { VoicePicker } from '@/components/voice/VoicePicker';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useTRPC } from '@/lib/trpc';

/** Голос за замовчуванням для кожної мови (модель + голос + ▶ зразок); проєкт може вибрати свій. */
export function DefaultVoices() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const settings = useQuery(trpc.settings.get.queryOptions());
  const set = useMutation(
    trpc.settings.setVoice.mutationOptions({
      onSuccess: () => qc.invalidateQueries({ queryKey: trpc.settings.get.queryKey() }),
      onError: (e) => toast.error(e.message),
    }),
  );
  const voices = settings.data?.voices ?? {};

  return (
    <Card data-testid="default-voices">
      <CardHeader>
        <CardTitle>Голоси за замовчуванням</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          Голос мови, що діє в усіх проєктах озвучки, доки в проєкті не вибрано свій.
        </p>
        {LANGUAGES.map((l) => (
          <div key={l.code} className="grid gap-1" data-testid={`default-voice-${l.code}`}>
            <span className="text-sm font-medium">
              {l.name} ({l.code.toUpperCase()})
            </span>
            <VoicePicker
              idPrefix={`dv-${l.code}`}
              language={l.code}
              value={voices[l.code] ?? null}
              fallback={null}
              withInstructions={false}
              onChange={(v) =>
                set.mutate({ language: l.code, voice: v ? { model: v.model, voiceId: v.voiceId } : null })
              }
            />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
