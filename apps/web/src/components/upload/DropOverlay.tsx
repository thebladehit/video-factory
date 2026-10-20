import { Upload } from 'lucide-react';
import { useEffect, useState } from 'react';

const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');

/** Перетягування файлів з ОС на будь-яку сторінку застосунку. */
export function DropOverlay({ onFiles }: { onFiles: (files: File[]) => void }) {
  const [active, setActive] = useState(false);

  useEffect(() => {
    let depth = 0; // dragenter/dragleave приходять для кожного вкладеного елемента
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setActive(true);
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setActive(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setActive(false);
      onFiles(Array.from(e.dataTransfer!.files));
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [onFiles]);

  if (!active) return null;
  return (
    <div
      data-testid="drop-overlay"
      className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm"
    >
      <div className="flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-primary p-12 text-lg font-medium">
        <Upload className="size-10 text-primary" />
        Відпустіть, щоб додати в бібліотеку
      </div>
    </div>
  );
}
