import { createFileRoute } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { NewProjectDialog } from '@/components/projects/NewProjectDialog';
import { ProjectGrid } from '@/components/projects/ProjectGrid';
import { Button } from '@/components/ui/button';

export const Route = createFileRoute('/')({ component: ProjectsPage });

function ProjectsPage() {
  const [creating, setCreating] = useState(false);
  return (
    <div className="mx-auto grid max-w-7xl gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Проєкти</h1>
        <Button onClick={() => setCreating(true)}>
          <Plus /> Новий проєкт
        </Button>
      </div>
      <ProjectGrid />
      <NewProjectDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}
