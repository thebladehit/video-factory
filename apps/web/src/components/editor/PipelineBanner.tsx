import { Link } from '@tanstack/react-router';
import { Clapperboard } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** Банер на час роботи конвеєра: документ лише для перегляду, збірка чернетки ще попереду. */
export function PipelineBanner({ projectId }: { projectId: string }) {
  return (
    <div
      data-testid="pipeline-banner"
      className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-sm"
    >
      <Clapperboard className="size-4 shrink-0" />
      <span>Конвеєр ще працює — чернетка з'явиться після збірки</span>
      <Button asChild size="sm" variant="outline" className="ml-auto">
        <Link to="/projects/$id/pipeline" params={{ id: projectId }}>
          До сторінки сцен
        </Link>
      </Button>
    </div>
  );
}
