import type { TimelineDoc } from '@vf/shared';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { planPaste, splitParagraphs } from '@/voice/paste-text';

const MAX_LINE_CHARS = 1500;

/** «Вставити текст» (німе відео): абзаци → сегменти (рівномірно) або в наявні сегменти по порядку. */
export function PasteTextDialog({
  open,
  onOpenChange,
  doc,
  language,
  busy,
  onApply,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  doc: TimelineDoc;
  /** Мова, до якої йдуть тексти (базова) */
  language: string;
  busy: boolean;
  onApply(paragraphs: string[]): void;
}) {
  const [text, setText] = useState('');
  // закрили (успіх, скасування) — текст не лишається й не застосується вдруге
  useEffect(() => {
    if (!open) setText('');
  }, [open]);
  const paragraphs = splitParagraphs(text);
  const plan = paragraphs.length ? planPaste(paragraphs, doc) : null;
  const tooLong = paragraphs.some((p) => p.length > MAX_LINE_CHARS);
  const hasSegments = (doc.segments?.length ?? 0) > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Вставити текст</DialogTitle>
          <DialogDescription>
            Кожен абзац (розділений порожнім рядком) — окремий сегмент мови {language.toUpperCase()}.{' '}
            {hasSegments
              ? 'Абзаци йдуть у наявні сегменти по порядку.'
              : 'Тривалість відео поділиться порівну між абзацами — межі потім можна перетягнути.'}
          </DialogDescription>
        </DialogHeader>
        <Textarea
          aria-label="Текст озвучки"
          data-testid="paste-text"
          rows={10}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'Перший абзац.\n\nДругий абзац.\n\nТретій абзац.'}
        />
        <div className="grid gap-1 text-sm" data-testid="paste-summary">
          {plan && <span className="text-muted-foreground">Абзаців: {paragraphs.length}</span>}
          {plan && plan.extra > 0 && plan.dropped < plan.extra && (
            <span data-testid="paste-warning" className="text-amber-700 dark:text-amber-500">
              Абзаців більше, ніж сегментів: {plan.extra - plan.dropped} нових сегментів буде додано в кінці.
            </span>
          )}
          {plan && plan.dropped > 0 && (
            <span data-testid="paste-dropped" className="text-destructive">
              Для {plan.dropped} абзаців немає місця на таймлайні — їх не буде вставлено.
            </span>
          )}
          {tooLong && (
            <span className="text-destructive">Абзац довший за {MAX_LINE_CHARS} символів — розділіть його.</span>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Скасувати
          </Button>
          <Button
            data-testid="paste-apply"
            disabled={busy || !plan || plan.assignments.length === 0 || tooLong}
            onClick={() => onApply(paragraphs)}
          >
            Вставити
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
