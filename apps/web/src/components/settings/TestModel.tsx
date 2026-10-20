import { useMutation } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { useTRPC } from '@/lib/trpc';

export function TestModel({ modelRef }: { modelRef: string | null }) {
  const trpc = useTRPC();
  const test = useMutation(trpc.ai.testModel.mutationOptions({ onError: () => {} }));
  return (
    <>
      <Button variant="outline" disabled={!modelRef || test.isPending} onClick={() => modelRef && test.mutate({ ref: modelRef })}>
        {test.isPending ? 'Перевіряю…' : 'Перевірити'}
      </Button>
      {(test.data || test.error) && (
        <span data-testid="test-model-result" className={test.error ? 'text-sm text-destructive' : 'text-sm'}>
          {test.error ? test.error.message : `«${test.data!.sample}» за ${test.data!.ms} мс`}
        </span>
      )}
    </>
  );
}
