import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PLATFORM_LABELS, type Platform } from '@vf/shared';
import { MoreVertical, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTRPC } from '@/lib/trpc';
import { AccountDialog, languageLabel } from './AccountDialog';
import { ConnectYoutubeDialog, useConnectYoutube } from './ConnectYoutubeDialog';
import type { AccountRow } from './types';

const PLATFORM_STYLE: Record<Platform, { short: string; className: string }> = {
  youtube: { short: 'YT', className: 'bg-red-600 text-white' },
  tiktok: { short: 'TT', className: 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900' },
  instagram: { short: 'IG', className: 'bg-gradient-to-br from-amber-500 via-pink-600 to-violet-600 text-white' },
  facebook: { short: 'FB', className: 'bg-blue-600 text-white' },
};

/** Позначка платформи (брендових іконок у lucide немає) */
export function PlatformIcon({ platform, className = '' }: { platform: Platform; className?: string }) {
  const s = PLATFORM_STYLE[platform];
  return (
    <span
      aria-label={PLATFORM_LABELS[platform]}
      title={PLATFORM_LABELS[platform]}
      className={`inline-flex size-7 shrink-0 items-center justify-center rounded-md text-[10px] font-bold ${s.className} ${className}`}
    >
      {s.short}
    </span>
  );
}

const NOT_CONFIGURED = 'Додайте YOUTUBE_CLIENT_ID і YOUTUBE_CLIENT_SECRET у .env';

/** Рядок акаунтів над матрицею: картки + «Підключити YouTube» і «Додати акаунт вручну» */
export function AccountsStrip() {
  const trpc = useTRPC();
  const list = useQuery(trpc.publish.accounts.list.queryOptions());
  const [connecting, setConnecting] = useState(false);
  const [adding, setAdding] = useState(false);
  const configured = list.data?.youtubeConfigured ?? false;

  return (
    <section data-testid="accounts-strip" className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-lg font-medium">Акаунти</h2>
        {configured ? (
          <Button data-testid="connect-youtube" onClick={() => setConnecting(true)}>
            <Plus /> Підключити YouTube
          </Button>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              {/* вимкнена кнопка не отримує подій миші — підказку показує обгортка */}
              <span tabIndex={0}>
                <Button data-testid="connect-youtube" disabled>
                  <Plus /> Підключити YouTube
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>{NOT_CONFIGURED}</TooltipContent>
          </Tooltip>
        )}
        <Button data-testid="add-manual-account" variant="outline" onClick={() => setAdding(true)}>
          <Plus /> Додати акаунт вручну
        </Button>
      </div>
      {list.isPending ? (
        <div className="flex gap-3">
          <Skeleton className="h-16 w-56" />
          <Skeleton className="h-16 w-56" />
        </div>
      ) : list.data?.accounts.length ? (
        <div className="flex flex-wrap gap-3">
          {list.data.accounts.map((a) => (
            <AccountCard key={a.id} account={a} />
          ))}
        </div>
      ) : (
        <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          Ще немає акаунтів. Підключіть YouTube-канал або додайте акаунт для ручної публікації.
        </p>
      )}
      <ConnectYoutubeDialog open={connecting} onOpenChange={setConnecting} />
      <AccountDialog open={adding} onOpenChange={setAdding} />
    </section>
  );
}

function AccountCard({ account }: { account: AccountRow }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const reconnect = useConnectYoutube();
  const remove = useMutation(
    trpc.publish.accounts.remove.mutationOptions({
      // каскадом зникають і завершені публікації акаунта
      onSuccess: () => qc.invalidateQueries({ queryKey: trpc.publish.pathKey() }),
    }),
  );
  const lost = account.status === 'reauth_required';

  return (
    <div
      data-testid="account-card"
      data-platform={account.platform}
      data-status={account.status}
      className={`flex min-w-56 items-center gap-3 rounded-lg border bg-card px-3 py-2 ${lost ? 'border-destructive' : ''}`}
    >
      <PlatformIcon platform={account.platform} />
      <div className="grid min-w-0 gap-0.5">
        <span className="truncate text-sm font-medium" title={account.name}>
          {account.profileUrl ? (
            <a href={account.profileUrl} target="_blank" rel="noreferrer" className="hover:underline">
              {account.name}
            </a>
          ) : (
            account.name
          )}
        </span>
        <span className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          {languageLabel(account.language)}
          <Badge variant="secondary">{account.method === 'api' ? 'API' : 'Вручну'}</Badge>
          {lost && <Badge variant="destructive">Потрібно перепідключити</Badge>}
        </span>
      </div>
      {lost && account.platform === 'youtube' && (
        <Button
          size="sm"
          variant="outline"
          disabled={reconnect.isPending}
          onClick={() => reconnect.mutate({ platform: 'youtube', language: account.language })}
        >
          <RefreshCw /> Перепідключити
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" className="ml-auto" aria-label="Дії з акаунтом">
            <MoreVertical />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setEditing(true)}>
            <Pencil /> Змінити
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}>
            <Trash2 /> Видалити
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AccountDialog open={editing} onOpenChange={setEditing} account={account} />
      <AlertDialog open={deleting} onOpenChange={setDeleting}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Видалити акаунт «{account.name}»?</AlertDialogTitle>
            <AlertDialogDescription>
              Завершені публікації цього акаунта зникнуть із матриці. Опубліковані відео на платформі лишаться.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Скасувати</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => remove.mutate({ id: account.id })}>
              Видалити
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
