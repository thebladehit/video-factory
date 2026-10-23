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

  it("get with fromByte 4 of 'fake-mp4' returns '-mp4' and size 8", async () => {
    const key = `${prefix}/range.mp4`;
    await storage.put(key, new TextEncoder().encode('fake-mp4'), { contentType: 'video/mp4' });
    const obj = await storage.get(key, { fromByte: 4 });
    expect(await text(obj.body)).toBe('-mp4');
    expect(obj.size).toBe(8);
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
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeTruthy();
  });

  it('allows cross-origin GET of media with range headers exposed (canvas preview, Web Audio)', async () => {
    const key = `${prefix}/media.bin`;
    await storage.put(key, new Uint8Array(100), { contentType: 'application/octet-stream' });
    const url = await storage.presignGet(key);
    const pre = await fetch(url, {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'range' },
    });
    expect(pre.headers.get('access-control-allow-origin')).toBeTruthy();
    const res = await fetch(url, { headers: { Origin: origin, Range: 'bytes=0-9' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('access-control-allow-origin')).toBeTruthy();
    const exposed = (res.headers.get('access-control-expose-headers') ?? '').toLowerCase();
    for (const h of ['content-length', 'content-range', 'accept-ranges']) expect(exposed).toContain(h);
  });

  it('ping fails fast when the endpoint is unreachable', async () => {
    const started = Date.now();
    await expect(createS3BlobStorage({ ...cfg, endpoint: 'http://localhost:1' }).ping()).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('multipart upload via presigned parts', async () => {
    const key = `${prefix}/multi.bin`;
    const uploadId = await storage.createMultipart(key, { contentType: 'application/octet-stream' });
    const chunks = [new Uint8Array(5 * 1024 * 1024), new TextEncoder().encode('0123456789')];
    const parts = [];
    for (const [i, body] of chunks.entries()) {
      const url = await storage.presignPart(key, uploadId, i + 1);
      const res = await fetch(url, { method: 'PUT', body });
      expect(res.ok).toBe(true);
      parts.push({ PartNumber: i + 1, ETag: res.headers.get('etag')! });
    }
    expect(await storage.listParts(key, uploadId)).toHaveLength(2);
    await storage.completeMultipart(key, uploadId, parts);
    expect(await storage.head(key)).toMatchObject({ size: 5 * 1024 * 1024 + 10 });
  });

  it('head of a missing key is null', async () => {
    expect(await storage.head(`${prefix}/nope`)).toBeNull();
  });

  it('abortMultipart is idempotent', async () => {
    const key = `${prefix}/aborted.bin`;
    const uploadId = await storage.createMultipart(key, { contentType: 'application/octet-stream' });
    await storage.abortMultipart(key, uploadId);
    await storage.abortMultipart(key, uploadId);
    await storage.abortMultipart(key, 'no-such-upload');
  });

  it('presigned urls use the public endpoint', async () => {
    const pub = createS3BlobStorage({ ...cfg, publicEndpoint: 'http://public.example:9000' });
    const urls = [
      await pub.presignPut(`${prefix}/p`, { contentType: 'image/png' }),
      await pub.presignGet(`${prefix}/p`),
      await pub.presignPart(`${prefix}/p`, 'upload-1', 1),
    ];
    for (const url of urls) expect(url.startsWith('http://public.example:9000/')).toBe(true);
  });
});
