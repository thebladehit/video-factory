import type { BlobStorage } from './blob-storage';

/**
 * Бакет і CORS створюються при першій потребі, а не лише на старті API:
 * якщо сховище піднялося пізніше за API, завантаження все одно запрацюють.
 */
export function createLazyBucket(storage: BlobStorage, opts: { corsOrigins: string[] }): { ensure(): Promise<void> } {
  let ready = false;
  let pending: Promise<void> | null = null;
  return {
    ensure() {
      if (ready) return Promise.resolve();
      pending ??= storage
        .ensureBucket(opts)
        .then(() => {
          ready = true;
        })
        .finally(() => {
          pending = null;
        });
      return pending;
    },
  };
}
