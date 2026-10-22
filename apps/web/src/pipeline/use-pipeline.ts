import { useQuery } from '@tanstack/react-query';
import { pipelineSettingsSchema } from '@vf/shared';
import { useEffect, useState } from 'react';
import { useTRPC } from '@/lib/trpc';
import { toSettings, type PipelineForm } from './settings-form';

/** Значення, що встановлюється через `ms` після останньої зміни. */
export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/** `pipeline.estimate` з debounce 300 мс; запит лише коли форма проходить схему (інакше API відповів би VALIDATION). */
export function usePipelineEstimate(form: PipelineForm) {
  const trpc = useTRPC();
  const debounced = useDebounced(form, 300);
  const settings = toSettings(debounced);
  const valid = pipelineSettingsSchema.safeParse(settings).success;
  const query = useQuery({
    ...trpc.pipeline.estimate.queryOptions(settings),
    enabled: valid,
    placeholderData: (prev) => prev,
  });
  return { estimate: valid ? query.data : undefined, pending: valid && (query.isFetching || debounced !== form) };
}
