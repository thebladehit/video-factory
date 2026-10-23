import { AccountsStrip } from './AccountsStrip';
import { PublishMatrix } from './PublishMatrix';

/** Вкладка «Публікації»: акаунти зверху, під ними — матриця «мовна версія × платформа» */
export function PublicationsPage() {
  return (
    <div className="mx-auto grid max-w-7xl gap-6">
      <h1 className="text-2xl font-semibold">Публікації</h1>
      <AccountsStrip />
      <PublishMatrix onPublish={() => undefined} />
    </div>
  );
}
