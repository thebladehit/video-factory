import { Languages } from 'lucide-react';
import { useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';

/** Банер мовного режиму: перегляд (з «Відокремити мову») або відокремлена мова (з «Повернути до спільного»). */
export function LanguageBanner({
  language,
  separated,
  busy,
  onSeparate,
  onUnseparate,
}: {
  language: string;
  separated: boolean;
  busy: boolean;
  onSeparate(): void;
  onUnseparate(): void;
}) {
  const [confirm, setConfirm] = useState(false);
  const code = language.toUpperCase();
  return (
    <div
      data-testid="language-banner"
      className="flex flex-wrap items-center gap-2 rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-1.5 text-sm"
    >
      <Languages className="size-4 shrink-0" />
      {separated ? (
        <span>Мова {code} відокремлена — редагується окремо від «Монтажу». Зміни «Монтажу» її не зачіпають.</span>
      ) : (
        <span>Перегляд мови {code} — редагування в «Монтажі» або «Відокремити мову»</span>
      )}
      <span className="ml-auto">
        {separated ? (
          <Button size="sm" variant="outline" disabled={busy} data-testid="unseparate" onClick={() => setConfirm(true)}>
            Повернути до спільного
          </Button>
        ) : (
          <Button size="sm" variant="outline" disabled={busy} data-testid="separate" onClick={onSeparate}>
            Відокремити мову
          </Button>
        )}
      </span>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent data-testid="unseparate-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Повернути мову {code} до спільного?</AlertDialogTitle>
            <AlertDialogDescription>
              Власний документ мови з усіма правками буде видалено. Мова знову збиратиметься автоматично з «Монтажу» й
              озвучки.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Скасувати</AlertDialogCancel>
            <AlertDialogAction data-testid="unseparate-ok" onClick={onUnseparate}>
              Повернути до спільного
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
