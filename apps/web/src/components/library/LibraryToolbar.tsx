import { Search, Sparkles, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { MEDIA_LIMITS } from '@vf/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useUploads } from '@/components/upload/UploadProvider';
import type { LibrarySearch } from './search';

const ACCEPT = Object.values(MEDIA_LIMITS)
  .flatMap((l) => l.mimes)
  .join(',');

function Filter<T extends string>(props: {
  label: string;
  value: T | undefined;
  options: Record<T, string>;
  onChange: (v: T | undefined) => void;
}) {
  return (
    <Select value={props.value ?? 'all'} onValueChange={(v) => props.onChange(v === 'all' ? undefined : (v as T))}>
      <SelectTrigger className="w-40" aria-label={props.label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{props.label}: усі</SelectItem>
        {(Object.entries(props.options) as [T, string][]).map(([v, l]) => (
          <SelectItem key={v} value={v}>
            {l}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function LibraryToolbar(props: {
  search: LibrarySearch;
  onSearch: (patch: Partial<LibrarySearch>) => void;
  onGenerate: () => void;
}) {
  const { addFiles } = useUploads();
  const fileInput = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState(props.search.q ?? '');
  const { onSearch } = props;

  useEffect(() => setQ(props.search.q ?? ''), [props.search.q]);
  useEffect(() => {
    if (q === (props.search.q ?? '')) return;
    const t = setTimeout(() => onSearch({ q: q || undefined }), 300);
    return () => clearTimeout(t);
  }, [q, props.search.q, onSearch]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-60 flex-1">
        <Search className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
        <Input
          aria-label="Пошук"
          placeholder="Пошук за назвою, тегами, описом…"
          className="pl-8"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <Filter
        label="Тип"
        value={props.search.kind}
        options={{ image: 'Фото', video: 'Відео', audio: 'Аудіо' }}
        onChange={(kind) => onSearch({ kind })}
      />
      <Filter
        label="Джерело"
        value={props.search.source}
        options={{ uploaded: 'Завантажені', generated: 'Згенеровані' }}
        onChange={(source) => onSearch({ source })}
      />
      <Filter
        label="Орієнтація"
        value={props.search.orientation}
        options={{ vertical: 'Вертикальні', horizontal: 'Горизонтальні', square: 'Квадратні' }}
        onChange={(orientation) => onSearch({ orientation })}
      />
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        accept={ACCEPT}
        data-testid="file-input"
        onChange={(e) => {
          addFiles(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
      <Button variant="outline" onClick={() => fileInput.current?.click()}>
        <Upload /> Завантажити
      </Button>
      <Button onClick={props.onGenerate}>
        <Sparkles /> Згенерувати
      </Button>
    </div>
  );
}
