import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Film, Loader2, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { formatDuration } from '@/components/library/format';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useUploads } from '@/components/upload/UploadProvider';
import { useTRPC } from '@/lib/trpc';

/** «Озвучити відео»: відео з бібліотеки або файл з ОС (після `ready` — `voice.createFromAsset`) → студія. */
export function NewVoiceDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const uploads = useUploads();
  const fileInput = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const started = useRef(new Set<string>());

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    if (open) {
      setQ('');
      setUploadId(null);
    }
  }, [open]);

  const library = useQuery({
    ...trpc.assets.list.queryOptions({ q: debounced || undefined, kind: 'video', limit: 40 }),
    enabled: open,
  });
  const items = (library.data?.items ?? []).filter((a) => a.status === 'ready');

  const create = useMutation(
    trpc.voice.createFromAsset.mutationOptions({
      onSuccess: ({ projectId }) => {
        onOpenChange(false);
        void navigate({ to: '/voice/$id', params: { id: projectId } });
      },
      onError: (e) => {
        setUploadId(null);
        toast.error(e.message);
      },
    }),
  );

  // файл з ОС: чекаємо `ready` (done) і лише тоді створюємо проєкт
  const upload = uploads.items.find((i) => i.id === uploadId);
  useEffect(() => {
    if (!upload) return;
    if (upload.state === 'error') {
      toast.error(upload.error ?? 'Не вдалося завантажити файл');
      setUploadId(null);
    } else if (upload.state === 'done' && !started.current.has(upload.id)) {
      started.current.add(upload.id);
      if (upload.assetId) create.mutate({ assetId: upload.assetId });
      else {
        toast.error('Файл завантажено, але його не знайдено в бібліотеці — спробуйте ще раз');
        setUploadId(null);
      }
    }
  }, [upload, create]);

  function pickFile(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith('video/')) {
      toast.error('Потрібен відеофайл');
      return;
    }
    const [id] = uploads.addFiles([file]);
    if (id) setUploadId(id);
  }

  const busy = create.isPending || (!!upload && upload.state !== 'error');

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Озвучити відео</DialogTitle>
          <DialogDescription>Виберіть відео з бібліотеки або завантажте файл.</DialogDescription>
        </DialogHeader>
        {busy ? (
          <div data-testid="voice-upload-status" className="flex items-center gap-2 py-8 text-muted-foreground">
            <Loader2 className="animate-spin" />
            {!upload
              ? 'Створюю проєкт…'
              : upload.state === 'uploading'
                ? `Завантаження ${Math.round(upload.progress)} %`
                : upload.state === 'processing'
                  ? 'Обробка файлу…'
                  : 'Створюю проєкт…'}
          </div>
        ) : (
          <div className="grid gap-3">
            <div
              data-testid="voice-dropzone"
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                pickFile(e.dataTransfer.files[0]);
              }}
              className={`flex flex-col items-center gap-2 rounded-lg border border-dashed p-6 text-sm text-muted-foreground ${dragging ? 'border-primary bg-accent' : ''}`}
            >
              <Upload className="size-6" />
              <p>Перетягніть відео сюди</p>
              <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
                Вибрати файл
              </Button>
              <input
                ref={fileInput}
                type="file"
                accept="video/*"
                hidden
                data-testid="voice-file-input"
                onChange={(e) => {
                  pickFile(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
            </div>
            <Input placeholder="Пошук у бібліотеці" value={q} onChange={(e) => setQ(e.target.value)} className="h-8" />
            <div className="grid max-h-64 grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2 overflow-y-auto">
              {items.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  data-testid="voice-library-item"
                  title={a.title}
                  onClick={() => create.mutate({ assetId: a.id })}
                  className="relative aspect-video overflow-hidden rounded-md border bg-muted hover:ring-2 hover:ring-primary"
                >
                  {a.thumbUrl ? (
                    <img src={a.thumbUrl} alt="" className="size-full object-cover" />
                  ) : (
                    <Film className="m-auto size-6 text-muted-foreground" />
                  )}
                  {a.durationMs !== null && (
                    <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1 text-[10px] text-white">
                      {formatDuration(a.durationMs)}
                    </span>
                  )}
                </button>
              ))}
              {!items.length && !library.isPending && (
                <p className="col-span-full text-xs text-muted-foreground">Відео не знайдено</p>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
