import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { Redis } from 'ioredis';
import { Worker } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { BullUploadQueue, JOB_DEFAULTS, processJobId, type ProcessUploadJob } from '../../../../packages/shared/src/queue.js';
import { S3Storage, storageKeys } from '../../../../packages/shared/src/storage.js';
import { BullReconQueue, RECON_DEBOUNCE_MS, RECON_QUEUE_NAME, type ReconJob } from '../../../../packages/shared/src/recon.js';

// A dedicated variable: the app's REDIS_URL (from .env) must never point tests at a shared Redis.
const redisUrl = process.env.TEST_REDIS_URL;
const describeRedis = redisUrl ? describe : describe.skip;

describeRedis('BullMQ upload queue (real Redis)', () => {
  // Connect in beforeAll: a skipped describe still runs its body, and an eager client would keep jest alive.
  let connection: Redis;
  let queue: BullUploadQueue;
  beforeAll(() => { connection = new Redis(redisUrl!, { maxRetriesPerRequest: null }); queue = new BullUploadQueue(connection); });
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
  it('recon: a burst of triggers runs once; triggers during a run give exactly one follow-up run', async () => {
    const recon = new BullReconQueue(connection);
    const tenantId = randomUUID();
    const runs: ReconJob[] = [];
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let started!: () => void;
    const first = new Promise<void>(r => { started = r; });
    const worker = new Worker<ReconJob>(RECON_QUEUE_NAME, async j => {
      if (j.data.tenantId !== tenantId) return;
      runs.push(j.data);
      if (runs.length === 1) { started(); await gate; }
    }, { connection });
    try {
      for (let i = 0; i < 20; i++) await recon.enqueueRecon(tenantId, 'manual');
      await first;
      for (let i = 0; i < 20; i++) await recon.enqueueRecon(tenantId, 'pricing.settings');
      release();
      await new Promise(r => setTimeout(r, RECON_DEBOUNCE_MS * 3));
      expect(runs.map(r => r.reason)).toEqual(['manual', 'pricing.settings']);
    } finally {
      await worker.close();
      await recon.close();
    }
  }, 30_000);
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
