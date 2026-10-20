import { randomUUID } from 'node:crypto';
import { text } from 'node:stream/consumers';
import { beforeAll, describe, expect, it } from 'vitest';
import { createS3BlobStorage, s3ConfigFromEnv } from './index';

const cfg = s3ConfigFromEnv(process.env);
const storage = createS3BlobStorage(cfg);
const prefix = `test/${randomUUID()}`;
const origin = 'http://localhost:5173';

beforeAll(async () => {
  await storage.ensureBucket({ corsOrigins: [origin] });
});

describe('S3BlobStorage', () => {
  it('ensureBucket is idempotent', async () => {
    await expect(storage.ensureBucket({ corsOrigins: [origin] })).resolves.toBeUndefined();
  });

  it('put then get returns same bytes and content type', async () => {
    const key = `${prefix}/a.png`;
    await storage.put(key, new TextEncoder().encode('hello'), { contentType: 'image/png' });
    const obj = await storage.get(key);
    expect(obj.contentType).toBe('image/png');
    expect(obj.size).toBe(5);
    expect(await text(obj.body)).toBe('hello');
  });

  it('get of a missing key throws NOT_FOUND', async () => {
    await expect(storage.get(`${prefix}/missing`)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('delete is idempotent', async () => {
    const key = `${prefix}/del.txt`;
    await storage.put(key, new TextEncoder().encode('x'), { contentType: 'text/plain' });
    await storage.delete(key);
    await storage.delete(key);
    await expect(storage.get(key)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('presigned PUT uploads and presigned GET downloads', async () => {
    const key = `${prefix}/video.mp4`;
    const putUrl = await storage.presignPut(key, { contentType: 'video/mp4' });
    const res = await fetch(putUrl, { method: 'PUT', body: 'fake-mp4', headers: { 'content-type': 'video/mp4' } });
    expect(res.status).toBe(200);
    expect(await text((await storage.get(key)).body)).toBe('fake-mp4');

    const getRes = await fetch(await storage.presignGet(key));
    expect(getRes.status).toBe(200);
    expect(await getRes.text()).toBe('fake-mp4');
  });

  it('answers CORS preflight for the web origin', async () => {
    const putUrl = await storage.presignPut(`${prefix}/cors.bin`, { contentType: 'application/octet-stream' });
    const res = await fetch(putUrl, {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-type' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeTruthy();
  });

  it('ping fails fast when the endpoint is unreachable', async () => {
    const started = Date.now();
    await expect(createS3BlobStorage({ ...cfg, endpoint: 'http://localhost:1' }).ping()).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
