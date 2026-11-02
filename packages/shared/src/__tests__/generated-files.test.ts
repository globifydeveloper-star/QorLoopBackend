import { describe, expect, it } from '@jest/globals';
import { generationJobId, generatedFileId, InlineGeneratedFilesQueue, type GenerateFileJob } from '../generated-files.js';

const job: GenerateFileJob = { tenantId: 'tenant-a', actorId: 'actor', requestId: 'request', marketplaceId: 'talabat', kind: 'price', scope: 'mismatches', reference: 'marketplace', requestedAt: '2026-11-02T12:00:01Z' };
describe('generation idempotency and queue', () => {
  it('deduplicates by tenant, resolved parameters and minute, independent of actor/request', async () => {
    const queue = new InlineGeneratedFilesQueue();
    const id = await queue.enqueue(job);
    expect(await queue.enqueue({ ...job, actorId: 'other', requestId: 'other', requestedAt: '2026-11-02T12:00:59Z' })).toBe(id);
    expect(queue.jobs.size).toBe(1);
    for (const change of [{ tenantId: 'tenant-b' }, { reference: 'erp' as const }, { kind: 'stock' as const }, { scope: 'all' as const }, { marketplaceId: 'snoonu' as const }, { requestedAt: '2026-11-02T12:01:00Z' }]) expect(generationJobId({ ...job, ...change })).not.toBe(id);
    expect(generatedFileId(id)).toMatch(/^[a-f\d]{8}-[a-f\d]{4}-5[a-f\d]{3}-8[a-f\d]{3}-[a-f\d]{12}$/);
    expect(generatedFileId(id)).toBe(generatedFileId(id));
    expect(await queue.status(id, 'tenant-b')).toBeNull();
    expect(await queue.status(id, 'tenant-a')).toEqual({ state: 'queued' });
    queue.handler = async () => ({ fileId: generatedFileId(id) });
    await queue.run(id);
    expect(await queue.status(id, 'tenant-a')).toEqual({ state: 'done', fileId: generatedFileId(id) });
  });
});
