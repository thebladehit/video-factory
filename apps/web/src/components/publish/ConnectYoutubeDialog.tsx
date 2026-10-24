import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { useTRPC } from '@/lib/trpc';
import { LanguageSelect } from './AccountDialog';

export const TESTING_HINT =
  'Поки Google-проєкт у режимі Testing, доступ діє 7 днів — потім канал доведеться перепідключити.';

/** Посилання згоди Google видає сервер (мутація: щоразу новий `state`) — далі перехід на нього */
export function useConnectYoutube() {
  const trpc = useTRPC();
  return useMutation(
    trpc.publish.accounts.connectUrl.mutationOptions({
      onSuccess: ({ url }) => window.location.assign(url),
    }),
  );
}

/** «Підключити YouTube»: вибір мови каналу → перехід на згоду Google */
export function ConnectYoutubeDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const [language, setLanguage] = useState('uk');
  const connect = useConnectYoutube();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Підключити YouTube</DialogTitle>
          <DialogDescription>Окремий канал на мову: відео цієї мови пропонуватимуться на цей канал.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="connect-language">Мова каналу</Label>
          <LanguageSelect id="connect-language" value={language} onChange={setLanguage} />
        </div>
        <DialogFooter className="flex-col items-stretch gap-2 sm:flex-col">
          <Button
            data-testid="connect-youtube-submit"
            disabled={connect.isPending}
            onClick={() => connect.mutate({ platform: 'youtube', language })}
          >
            Підключити через Google
          </Button>
          <p className="text-xs text-muted-foreground">{TESTING_HINT}</p>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
