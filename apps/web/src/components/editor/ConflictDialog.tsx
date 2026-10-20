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

export function ConflictDialog({
  open,
  onReload,
  onOverwrite,
}: {
  open: boolean;
  onReload(): void;
  onOverwrite(): void;
}) {
  return (
    <AlertDialog open={open}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Проєкт змінено в іншій вкладці</AlertDialogTitle>
          <AlertDialogDescription>
            «Перезавантажити» покаже збережену версію (ваші незбережені зміни зникнуть). «Перезаписати моєю версією»
            збереже те, що відкрито тут.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onReload}>Перезавантажити</AlertDialogCancel>
          <AlertDialogAction onClick={onOverwrite}>Перезаписати моєю версією</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
