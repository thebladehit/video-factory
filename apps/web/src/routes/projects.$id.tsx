import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { EditorPage } from '@/components/editor/EditorPage';
import { useTRPC } from '@/lib/trpc';

export const Route = createFileRoute('/projects/$id')({ component: ProjectPage });

function ProjectPage() {
  const { id } = Route.useParams();
  const trpc = useTRPC();
  // знімок для старту сесії; далі джерело правди — стор редактора
  const project = useQuery({
    ...trpc.projects.get.queryOptions({ id }),
    staleTime: Infinity,
    refetchOnMount: 'always',
  });
  if (project.isError) return <p className="text-destructive">{project.error.message}</p>;
  if (!project.data) return <p className="text-muted-foreground">Завантаження…</p>;
  return <EditorPage key={id} project={project.data} />;
}
