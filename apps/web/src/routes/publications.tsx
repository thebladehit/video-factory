import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { PublicationsPage } from '@/components/publish/PublicationsPage';
import { useTRPC } from '@/lib/trpc';

type ConnectError = 'denied' | 'state' | 'exchange' | 'noChannel' | 'notConfigured';

interface PublicationsSearch {
  /** id підключеного акаунта після повернення з OAuth */
  connected?: string;
  connectError?: ConnectError;
}

const CONNECT_ERRORS: Record<ConnectError, string> = {
  denied: 'Доступ не надано',
  state: 'Посилання підключення застаріло — спробуйте ще раз',
  exchange: 'Не вдалося підключити канал',
  noChannel: 'На цьому Google-акаунті немає YouTube-каналу',
  notConfigured: 'YouTube не налаштовано на сервері',
};

export const Route = createFileRoute('/publications')({
  validateSearch: (raw: Record<string, unknown>): PublicationsSearch => ({
    connected: typeof raw.connected === 'string' && raw.connected ? raw.connected : undefined,
    connectError:
      typeof raw.connectError === 'string' && Object.hasOwn(CONNECT_ERRORS, raw.connectError)
        ? (raw.connectError as ConnectError)
        : undefined,
  }),
  component: PublicationsRoute,
});

function PublicationsRoute() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: '/publications' });
  const trpc = useTRPC();
  const qc = useQueryClient();
  // повернення з OAuth: один тост на посилання (StrictMode запускає ефект двічі)
  const shown = useRef<string | null>(null);
  useEffect(() => {
    const key = search.connected ?? search.connectError;
    if (!key || shown.current === key) return;
    shown.current = key;
    if (search.connected) {
      toast.success('Канал підключено');
      void qc.invalidateQueries({ queryKey: trpc.publish.accounts.list.queryKey() });
    } else if (search.connectError) toast.error(CONNECT_ERRORS[search.connectError]);
    void navigate({ search: {}, replace: true });
  }, [search.connected, search.connectError, navigate, qc, trpc]);
  return <PublicationsPage />;
}
