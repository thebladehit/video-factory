import { useSubscription } from '@trpc/tanstack-react-query';
import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import type { JobEvent } from '@vf/shared';
import { useTRPC } from '@/lib/trpc';

type Listener = (e: JobEvent) => void;
const FeedContext = createContext<Set<Listener> | null>(null);

/** Одна SSE-підписка на всі задачі користувача на весь застосунок (браузер тримає ~6 з'єднань на хост). */
export function JobFeedProvider({ children }: { children: ReactNode }) {
  const trpc = useTRPC();
  const listeners = useRef(new Set<Listener>()).current;
  useSubscription(
    trpc.jobs.feed.subscriptionOptions(undefined, {
      onData: (e) => {
        for (const l of listeners) l(e);
      },
    }),
  );
  return <FeedContext.Provider value={listeners}>{children}</FeedContext.Provider>;
}

export function useJobFeed(onEvent: Listener): void {
  const listeners = useContext(FeedContext);
  const latest = useRef(onEvent);
  latest.current = onEvent;
  useEffect(() => {
    if (!listeners) return;
    const l: Listener = (e) => latest.current(e);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, [listeners]);
}
