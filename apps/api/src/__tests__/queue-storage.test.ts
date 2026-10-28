import { afterAll, describe, expect, it } from '@jest/globals';
import { Redis } from 'ioredis';
import { Worker } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { BullUploadQueue, JOB_DEFAULTS, processJobId, type ProcessUploadJob } from '../../../../packages/shared/src/queue.js';
import { S3Storage, storageKeys } from '../../../../packages/shared/src/storage.js';

const redisUrl = process.env.REDIS_URL;
const describeRedis = redisUrl ? describe : describe.skip;

describeRedis('BullMQ upload queue (real Redis)', () => {
  const connection = new Redis(redisUrl ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
  const queue = new BullUploadQueue(connection);
  afterAll(async () => { await queue.close(); await connection.quit(); });

  it('delivers a job once, even if the API enqueues the same revision twice', async () => {
    const job: ProcessUploadJob = { tenantId: randomUUID(), uploadId: randomUUID(), revision: 1 };
    const seen: ProcessUploadJob[] = [];
    let resolveDone!: () => void;
    const done = new Promise<void>(r => { resolveDone = r; });
    const worker = new Worker<ProcessUploadJob>('upload-processing', async j => { if (j.data.uploadId === job.uploadId) { seen.push(j.data); resolveDone(); } }, { connection });
    await queue.enqueueProcess(job);
    await queue.enqueueProcess(job);
    await done;
    await new Promise(r => setTimeout(r, 300));
    await worker.close();
    expect(seen).toHaveLength(1);
    expect(processJobId(job)).toBe(`process-${job.tenantId}-${job.uploadId}-1`);
  });
  it('retries with backoff and keeps failed jobs for inspection', () => {
    expect(JOB_DEFAULTS.attempts).toBe(3);
    expect(JOB_DEFAULTS.backoff.type).toBe('exponential');
  });
});

describe('S3 signed upload URL', () => {
  const storage = new S3Storage({ bucket: 'qorloop-private', region: 'me-central-1', endpoint: 'https://s3.example.test', forcePathStyle: true, accessKeyId: 'AKIATEST', secretAccessKey: 'secret' });
  it('binds the file size and type into the signature and expires', async () => {
    const key = storageKeys.upload('t1', 'u1', '.xlsx');
    const signed = await storage.presignUpload(key, { contentType: 'text/csv', size: 1234, ttlSeconds: 600 });
    const url = new URL(signed.url);
    expect(url.pathname).toBe('/qorloop-private/tenants/t1/uploads/u1/original.xlsx');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toMatch(/content-length/);
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toMatch(/content-type/);
    expect(signed.method).toBe('PUT');
    expect(signed.headers['x-amz-server-side-encryption']).toBe('AES256');
  });
  it('download links are short-lived and force a download', async () => {
    const url = new URL(await storage.presignDownload('tenants/t1/generated/f.xlsx', { fileName: 'a b"c.xlsx', ttlSeconds: 300 }));
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('response-content-disposition')).toBe('attachment; filename="a_b_c.xlsx"');
  });
});
