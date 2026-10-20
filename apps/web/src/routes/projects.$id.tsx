import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useTRPC } from '@/lib/trpc';

export const Route = createFileRoute('/projects/$id')({ component: ProjectPage });

function ProjectPage() {
  const { id } = Route.useParams();
  const trpc = useTRPC();
  const project = useQuery(trpc.projects.get.queryOptions({ id }));
  return <h1 className="text-2xl font-semibold">{project.data?.title ?? '…'}</h1>;
}
