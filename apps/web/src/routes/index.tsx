import { createFileRoute } from '@tanstack/react-router';
import { ComingSoon } from '@/components/ComingSoon';

export const Route = createFileRoute('/')({
  component: () => (
    <ComingSoon title="Проєкти" subproject={2} about="Конвеєр «тема → чернетка» і редактор з таймлайном." />
  ),
});
