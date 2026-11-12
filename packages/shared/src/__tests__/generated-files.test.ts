import { describe, expect, it } from '@jest/globals';
import { exportToken, generationJobId, generatedFileId, InlineGeneratedFilesQueue, type GenerateFileJob, type GenerationInputs } from '../generated-files.js';
import { GENERATION_JOB_ID_MAX, generationJobIdParam } from '../contracts.js';
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
    // the whole token counts, not a prefix of it
    expect(generationJobId({ ...job, exportToken: 'a'.repeat(63) + 'b' })).not.toBe(generationJobId({ ...job, exportToken: token }));
  });
  it('has a fixed length that fits the jobs/:jobId route, whatever the parameters and token', () => {
    const tenantId = '00000000-0000-4000-8000-000000000000';
    const longest: GenerateFileJob = { ...job, tenantId, marketplaceId: 'talabat', kind: 'stock_price', scope: 'mismatches', reference: 'marketplace', requestedAt: '9999-12-31T23:59:59Z', exportToken: 'f'.repeat(64) };
    for (const j of [longest, { ...job, tenantId }]) {
      const id = generationJobId(j);
      expect(id).toMatch(new RegExp(`^generate-${tenantId}-[a-f0-9]{32}$`));
      expect(id).toHaveLength(78);
      expect(generationJobIdParam.safeParse(id).success).toBe(true);
    }
    expect(GENERATION_JOB_ID_MAX).toBe(100);
  });
  it('follows exactly what the file would write', () => {
    const t = exportToken(inputs([row]), job);
    expect(exportToken(inputs([{ ...row }]), job)).toBe(t);
    expect(exportToken(inputs([{ ...row, exportPrice: 2.75, overridesPrice: true, pendingPrice: true }]), job)).not.toBe(t);
    expect(exportToken(inputs([{ ...row, marketplacePrice: 2.6 }]), job)).not.toBe(t);
    expect(exportToken(inputs([row]), { ...job, kind: 'stock' })).not.toBe(t);
  });
});
