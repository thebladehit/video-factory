import { Check, ChevronDown, ChevronUp, RotateCcw, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useUploads, type UploadItem } from './UploadProvider';

const speedLabel = (bps: number) =>
  bps >= 1024 ** 2 ? `${(bps / 1024 ** 2).toFixed(1)} МБ/с` : `${Math.round(bps / 1024)} КБ/с`;

function Row({ item }: { item: UploadItem }) {
  const { cancel, retry } = useUploads();
  return (
    <li className="grid gap-1" data-testid="upload-item">
      <div className="flex items-center gap-2 text-sm">
        <span className="min-w-0 flex-1 truncate" title={item.name}>
          {item.name}
        </span>
        {item.state === 'uploading' && (
          <>
            <span className="text-xs tabular-nums text-muted-foreground">{speedLabel(item.bytesPerSec)}</span>
            <Button
              size="icon"
              variant="ghost"
              className="size-6"
              aria-label="Скасувати"
              onClick={() => cancel(item.id)}
            >
              <X />
            </Button>
          </>
        )}
        {item.state === 'processing' && <span className="text-xs text-muted-foreground">Обробка…</span>}
        {item.state === 'done' && <Check className="size-4 text-green-600" aria-label="Готово" />}
        {item.state === 'error' && (
          <Button size="icon" variant="ghost" className="size-6" aria-label="Повторити" onClick={() => retry(item.id)}>
            <RotateCcw />
          </Button>
        )}
      </div>
      {item.state === 'uploading' && <Progress value={item.progress} className="h-1" />}
      {item.error && <p className="text-xs text-destructive">{item.error}</p>}
    </li>
  );
}

/** Плаваюча панель завантажень (правий нижній кут). */
export function UploadPanel() {
  const { items, clearFinished } = useUploads();
  const [collapsed, setCollapsed] = useState(false);
  const active = items.filter((i) => i.state !== 'done').length;

  // усе готово — через 5 с ховаємо
  useEffect(() => {
    if (!items.length || active) return;
    const t = setTimeout(clearFinished, 5000);
    return () => clearTimeout(t);
  }, [items.length, active, clearFinished]);

  if (!items.length) return null;
  return (
    <section
      data-testid="upload-panel"
      className="fixed right-4 bottom-4 z-40 w-80 rounded-lg border bg-card text-card-foreground shadow-lg"
    >
      <header className="flex items-center justify-between border-b px-3 py-2 text-sm font-medium">
        Завантаження ({items.length})
        <Button
          size="icon"
          variant="ghost"
          className="size-6"
          aria-label={collapsed ? 'Розгорнути' : 'Згорнути'}
          onClick={() => setCollapsed(!collapsed)}
        >
          {collapsed ? <ChevronUp /> : <ChevronDown />}
        </Button>
      </header>
      {!collapsed && (
        <ul className="grid max-h-72 gap-3 overflow-y-auto p-3">
          {items.map((i) => (
            <Row key={i.id} item={i} />
          ))}
        </ul>
      )}
    </section>
  );
}
