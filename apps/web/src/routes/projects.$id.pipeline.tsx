import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/projects/$id/pipeline')({ component: PipelinePlaceholder });

// Заглушка: Task 11 замінює вміст сторінкою сцен
function PipelinePlaceholder() {
  return <p className="text-muted-foreground">Сторінка сцен конвеєра</p>;
}
