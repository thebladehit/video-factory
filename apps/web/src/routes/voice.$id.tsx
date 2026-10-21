import { createFileRoute } from '@tanstack/react-router';
import { StudioPage } from '@/components/voice/StudioPage';

export const Route = createFileRoute('/voice/$id')({ component: VoiceStudioRoute });

function VoiceStudioRoute() {
  const { id } = Route.useParams();
  return <StudioPage key={id} projectId={id} />;
}
