import { createFileRoute } from '@tanstack/react-router';
import { ComingSoon } from '@/components/ComingSoon';

export const Route = createFileRoute('/library')({
  component: () => <ComingSoon title="Бібліотека" subproject={1} about="Генерація й завантаження фото та відео, теги, пошук." />,
});
