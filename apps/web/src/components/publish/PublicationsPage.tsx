import { useState } from 'react';
import { AccountsStrip } from './AccountsStrip';
import { EditPublicationDialog } from './EditPublicationDialog';
import { PublishDialog } from './PublishDialog';
import { PublishMatrix, type PublishTarget } from './PublishMatrix';
import type { PublicationRow } from './types';

/** Вкладка «Публікації»: акаунти зверху, під ними — матриця «мовна версія × платформа» */
export function PublicationsPage() {
  const [publishing, setPublishing] = useState<PublishTarget | null>(null);
  const [editing, setEditing] = useState<PublicationRow | null>(null);
  return (
    <div className="mx-auto grid max-w-7xl gap-6">
      <h1 className="text-2xl font-semibold">Публікації</h1>
      <AccountsStrip />
      <PublishMatrix onPublish={setPublishing} onEdit={setEditing} />
      <PublishDialog
        open={publishing !== null}
        onOpenChange={(o) => !o && setPublishing(null)}
        projectId={publishing?.projectId}
        language={publishing?.language}
        platform={publishing?.platform}
      />
      <EditPublicationDialog publication={editing} onOpenChange={(o) => !o && setEditing(null)} />
    </div>
  );
}
