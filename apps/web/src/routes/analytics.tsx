import { createFileRoute } from '@tanstack/react-router';
import { ComingSoon } from '@/components/ComingSoon';

export const Route = createFileRoute('/analytics')({
  component: () => <ComingSoon title="Статистика" subproject={6} about="Перегляди й метрики по кожному відео." />,
});
