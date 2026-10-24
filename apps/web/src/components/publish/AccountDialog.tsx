import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LANGUAGES, PLATFORM_LABELS, PLATFORMS, type Platform } from '@vf/shared';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useTRPC } from '@/lib/trpc';
import type { AccountRow } from './types';

/** Назва мови для підписів: «Українська (UK)» */
export const languageLabel = (code: string) => {
  const l = LANGUAGES.find((x) => x.code === code);
  return l ? `${l.name} (${code.toUpperCase()})` : code.toUpperCase();
};

/** Вибір мови зі списку, як у налаштуваннях голосів */
export function LanguageSelect({
  id,
  value,
  onChange,
  disabled,
}: {
  id?: string;
  value: string;
  onChange(code: string): void;
  disabled?: boolean;
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue placeholder="Мова" />
      </SelectTrigger>
      <SelectContent>
        {LANGUAGES.map((l) => (
          <SelectItem key={l.code} value={l.code}>
            {l.name} ({l.code.toUpperCase()})
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Створення ручного акаунта або редагування наявного (будь-якого методу).
 * `platform`/`language` — наперед задані значення для нового акаунта (з діалогу публікації).
 */
export function AccountDialog({
  open,
  onOpenChange,
  account,
  platform,
  language,
  onCreated,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  account?: AccountRow;
  platform?: Platform;
  language?: string;
  onCreated?(account: AccountRow): void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {open && (
          <AccountForm
            account={account}
            platform={platform}
            language={language}
            onDone={(created) => {
              if (created) onCreated?.(created);
              onOpenChange(false);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function AccountForm({
  account,
  platform: initialPlatform,
  language: initialLanguage,
  onDone,
}: {
  account?: AccountRow;
  platform?: Platform;
  language?: string;
  onDone(created?: AccountRow): void;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [platform, setPlatform] = useState<Platform>(account?.platform ?? initialPlatform ?? 'tiktok');
  const [name, setName] = useState(account?.name ?? '');
  const [language, setLanguage] = useState(account?.language ?? initialLanguage ?? 'uk');
  const [profileUrl, setProfileUrl] = useState(account?.profileUrl ?? '');
  const refresh = () => qc.invalidateQueries({ queryKey: trpc.publish.accounts.list.queryKey() });
  const create = useMutation(
    trpc.publish.accounts.createManual.mutationOptions({
      onSuccess: (a) => {
        void refresh();
        toast.success('Акаунт додано');
        onDone(a);
      },
    }),
  );
  const update = useMutation(
    trpc.publish.accounts.update.mutationOptions({
      onSuccess: () => {
        void refresh();
        onDone();
      },
    }),
  );
  const pending = create.isPending || update.isPending;

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        if (account) update.mutate({ id: account.id, name: name.trim(), language, profileUrl: profileUrl.trim() });
        else create.mutate({ platform, name: name.trim(), language, profileUrl: profileUrl.trim() || undefined });
      }}
    >
      <DialogHeader>
        <DialogTitle>{account ? 'Змінити акаунт' : 'Додати акаунт вручну'}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-2">
        <Label htmlFor="account-platform">Платформа</Label>
        <Select value={platform} onValueChange={(v) => setPlatform(v as Platform)} disabled={Boolean(account)}>
          <SelectTrigger id="account-platform" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PLATFORMS.map((p) => (
              <SelectItem key={p} value={p}>
                {PLATFORM_LABELS[p]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="account-name">Назва</Label>
        <Input
          id="account-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={100}
          placeholder="Напр. @mychannel"
          autoFocus
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="account-language">Мова каналу</Label>
        <LanguageSelect id="account-language" value={language} onChange={setLanguage} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="account-profile">Посилання на профіль (необов'язково)</Label>
        <Input
          id="account-profile"
          type="url"
          value={profileUrl}
          onChange={(e) => setProfileUrl(e.target.value)}
          placeholder="https://"
        />
      </div>
      <DialogFooter>
        <Button type="submit" disabled={!name.trim() || pending}>
          {account ? 'Зберегти' : 'Додати'}
        </Button>
      </DialogFooter>
    </form>
  );
}
