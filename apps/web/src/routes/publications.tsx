import { createFileRoute } from '@tanstack/react-router';
import { ComingSoon } from '@/components/ComingSoon';

export const Route = createFileRoute('/publications')({
  component: () => (
    <ComingSoon title="Публікації" subproject={5} about="Автопублікація на YouTube, TikTok, Instagram і Facebook." />
  ),
});
