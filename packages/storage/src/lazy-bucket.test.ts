import { describe, expect, it, vi } from 'vitest';
import type { BlobStorage } from './blob-storage';
import { createLazyBucket } from './lazy-bucket';

describe('createLazyBucket', () => {
  it('retries after failure and memoizes success', async () => {
    const ensureBucket = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue(undefined);
    const bucket = createLazyBucket({ ensureBucket } as unknown as BlobStorage, { corsOrigins: ['http://x'] });
    await expect(bucket.ensure()).rejects.toThrow('down');
    await bucket.ensure();
    await bucket.ensure();
    expect(ensureBucket).toHaveBeenCalledTimes(2);
    expect(ensureBucket).toHaveBeenLastCalledWith({ corsOrigins: ['http://x'] });
  });

  it('concurrent calls share one attempt', async () => {
    const ensureBucket = vi.fn(() => new Promise<void>((r) => setTimeout(r, 20)));
    const bucket = createLazyBucket({ ensureBucket } as unknown as BlobStorage, { corsOrigins: [] });
    await Promise.all([bucket.ensure(), bucket.ensure(), bucket.ensure()]);
    expect(ensureBucket).toHaveBeenCalledTimes(1);
  });
});
