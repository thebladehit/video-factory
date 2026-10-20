import { createFileRoute } from '@tanstack/react-router';
import { ComingSoon } from '@/components/ComingSoon';

export const Route = createFileRoute('/voice')({
  component: () => <ComingSoon title="Студія озвучки" subproject={3} about="Озвучка готових відео кількома мовами з субтитрами." />,
});
