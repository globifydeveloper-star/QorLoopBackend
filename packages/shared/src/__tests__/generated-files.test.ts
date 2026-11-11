import { describe, expect, it } from '@jest/globals';
import { exportToken, generationJobId, generatedFileId, InlineGeneratedFilesQueue, type GenerateFileJob, type GenerationInputs } from '../generated-files.js';
import type { FileReconRow } from '../../../core/src/generated-files.js';

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

describe('export tokens (migration 202611100001)', () => {
  const row: FileReconRow = { productId: 'p1', name: 'Milk', marketplaceProductId: 'T1', erpPrice: 2, marketplacePrice: 2.5, available: true, actualPrice: 2,
    stockIssue: null, priceMismatchVsErp: false, priceMismatchVsMarketplace: true, status: 'mismatch' };
  const inputs = (rows: FileReconRow[]) => ({ upload: { id: 'u1' }, referenceUsed: 'marketplace', rows }) as unknown as GenerationInputs;
  it('an export token makes a new job within the same minute, and the same token the same job', () => {
    const token = 'a'.repeat(64);
    expect(generationJobId({ ...job, exportToken: token })).not.toBe(generationJobId(job));
    expect(generationJobId({ ...job, exportToken: token })).toBe(generationJobId({ ...job, exportToken: token, requestedAt: '2026-11-02T12:00:30Z' }));
  });
  it('follows exactly what the file would write', () => {
    const t = exportToken(inputs([row]), job);
    expect(exportToken(inputs([{ ...row }]), job)).toBe(t);
    expect(exportToken(inputs([{ ...row, exportPrice: 2.75, overridesPrice: true, pendingPrice: true }]), job)).not.toBe(t);
    expect(exportToken(inputs([{ ...row, marketplacePrice: 2.6 }]), job)).not.toBe(t);
    expect(exportToken(inputs([row]), { ...job, kind: 'stock' })).not.toBe(t);
  });
});
