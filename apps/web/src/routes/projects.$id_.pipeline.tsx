import { createFileRoute } from '@tanstack/react-router';
import { PipelinePage } from '@/components/pipeline/PipelinePage';

// `$id_` — не вкладено в `projects.$id` (редактор без <Outlet/>): сторінка сцен рендериться окремо
export const Route = createFileRoute('/projects/$id_/pipeline')({ component: PipelineRoute });

function PipelineRoute() {
  const { id } = Route.useParams();
  return <PipelinePage key={id} projectId={id} />;
}
