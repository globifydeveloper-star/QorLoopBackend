// ADR 022: the Owner resets the store's business data from Settings (GET/POST /api/store/reset), and the worker deletes
// the files no row points at any more. The plan's SQL itself is covered by store-reset.integration.test.ts (ADR 018).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { createHarness, sessionToken, type Harness, type Session, type Store } from './harness.js';
import { digest } from '../../../../packages/shared/src/security.js';
import { cleanStoreStorage } from '../../../worker/src/clean-store-storage.js';

let h: Harness;
let a: Store, b: Store;
let admin: Session;

async function seedBusinessData(store: Store) {
  const p = h.fixture.prisma;
  const owner = await p.membership.findFirstOrThrow({ where: { tenantId: store.id, role: 'owner' } });
  const category = await p.category.create({ data: { tenantId: store.id, nameEn: 'Food' } });
  const product = await p.product.create({ data: { tenantId: store.id, barcode: '6281000000011', normalizedBarcode: '6281000000011', nameEn: 'Chips', erpPrice: 5, erpStock: 3, categoryId: category.id } });
  await p.productOffer.create({ data: { tenantId: store.id, productId: product.id, price: 4.5 } });
  const uploadKey = `tenants/${store.id}/uploads/${randomUUID()}/original.xlsx`;
  await p.upload.create({ data: { tenantId: store.id, source: 'erp', fileName: 'erp.xlsx', size: 3, storageKey: uploadKey, uploadedById: owner.userId, status: 'applied', appliedAt: new Date() } });
  const fileKey = `tenants/${store.id}/generated/${randomUUID()}.csv`;
  await p.generatedFile.create({ data: { tenantId: store.id, marketplaceId: 'talabat', kind: 'stock', scope: 'all', reference: 'erp', fileName: 'f.csv', storageKey: fileKey, productCount: 1, generatedById: owner.userId, expiresAt: new Date(Date.now() + 86_400_000) } });
  await p.auditEvent.create({ data: { tenantId: store.id, action: 'upload.applied', actorId: owner.userId } });
  await h.storage.put(uploadKey, Buffer.from('erp'));
  await h.storage.put(fileKey, Buffer.from('csv'));
  return { uploadKey, fileKey };
}
const counts = async (tenantId: string) => {
  const p = h.fixture.prisma;
  return { products: await p.product.count({ where: { tenantId } }), uploads: await p.upload.count({ where: { tenantId } }), users: await p.user.count({ where: { tenantId } }) };
};
const clearStepUp = (s: Session) => h.fixture.prisma.session.update({ where: { tokenHash: digest(sessionToken(s)) }, data: { stepUpAt: null } });

beforeAll(async () => {
  h = await createHarness();
  a = await h.createOwner('reset-a');
  b = await h.createOwner('reset-b');
  admin = await h.member(a, 'admin');
}, 120_000);
afterAll(async () => { await h?.close(); });

describe('in-app store reset', () => {
  it('shows the Owner what would be deleted; nobody else may see or do it', async () => {
    await seedBusinessData(a);
    const preview = await h.request('GET', '/api/store/reset', a, a.owner);
    expect(preview.statusCode).toBe(200);
    expect(preview.json().data).toMatchObject({ store: { slug: 'reset-a' }, inFlightUploads: 0, blockedReason: null,
      deletes: { products: 1, categories: 1, uploads: 1, generatedFiles: 1, offers: 1 } });
    expect((await h.request('GET', '/api/store/reset', a, admin)).statusCode).toBe(403);
    expect((await h.request('POST', '/api/store/reset', a, admin, { confirmSlug: 'reset-a' })).statusCode).toBe(403);
    const me = await h.request('GET', '/api/auth/me', a, a.owner);
    expect(me.json().data.permissions).toContain('store.reset');
  });

  it('needs a fresh code and the exact slug; a refused attempt keeps the code', async () => {
    await clearStepUp(a.owner);
    const noCode = await h.request('POST', '/api/store/reset', a, a.owner, { confirmSlug: 'reset-a' });
    expect(noCode.statusCode).toBe(403);
    expect(noCode.json()).toMatchObject({ error: { code: 'STEP_UP_REQUIRED' } });
    await h.stepUp(a.owner);
    const wrong = await h.request('POST', '/api/store/reset', a, a.owner, { confirmSlug: 'reset-b' });
    expect(wrong.statusCode).toBe(400);
    expect(JSON.stringify(wrong.json())).toContain('confirmSlug');
    expect((await counts(a.id)).products).toBe(1);
    // the step-up was not consumed by the refused request (it rolled back)
    const session = await h.fixture.prisma.session.findUniqueOrThrow({ where: { tokenHash: digest(sessionToken(a.owner)) } });
    expect(session.stepUpAt).not.toBeNull();
  });

  it('waits for an upload that is still being processed', async () => {
    const owner = await h.fixture.prisma.membership.findFirstOrThrow({ where: { tenantId: a.id, role: 'owner' } });
    const busy = await h.fixture.prisma.upload.create({ data: { tenantId: a.id, source: 'erp', fileName: 'busy.xlsx', size: 1, storageKey: `tenants/${a.id}/uploads/${randomUUID()}/original.xlsx`, uploadedById: owner.userId, status: 'processing' } });
    expect((await h.request('GET', '/api/store/reset', a, a.owner)).json().data).toMatchObject({ inFlightUploads: 1, blockedReason: expect.any(String) });
    const refused = await h.request('POST', '/api/store/reset', a, a.owner, { confirmSlug: 'reset-a' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toMatch(/still being processed/);
    expect((await counts(a.id)).products).toBe(1);
    await h.fixture.prisma.upload.delete({ where: { id: busy.id } });
  });

  it('deletes this store\'s business data only, records who did it and queues the file clean-up', async () => {
    const otherFiles = await seedBusinessData(b);
    const before = { a: await counts(a.id), b: await counts(b.id) };
    await h.stepUp(a.owner);
    const done = await h.request('POST', '/api/store/reset', a, a.owner, { confirmSlug: ' Reset-A ' });
    expect(done.statusCode).toBe(200);
    const result = done.json().data as { eventId: string; deleted: Record<string, number>; storageCleanup: string };
    expect(result).toMatchObject({ storageCleanup: 'queued', deleted: { products: 1, uploads: 1, generatedFiles: 1 } });
    expect(await counts(a.id)).toEqual({ products: 0, uploads: 0, users: before.a.users });
    expect(await counts(b.id)).toEqual(before.b);
    const event = await h.fixture.prisma.auditEvent.findUniqueOrThrow({ where: { id: result.eventId } });
    const owner = await h.fixture.prisma.membership.findFirstOrThrow({ where: { tenantId: a.id, role: 'owner' } });
    expect(event).toMatchObject({ action: 'store.data_reset', actorId: owner.userId, details: { source: 'app' } });
    expect(await h.fixture.prisma.auditEvent.count({ where: { tenantId: a.id, action: 'upload.applied' } })).toBe(0);
    expect(h.storeCleanup.jobs.at(-1)).toMatchObject({ tenantId: a.id, resetEventId: result.eventId });
    // the session stays signed in; the single-use code is spent
    expect((await h.request('GET', '/api/auth/me', a, a.owner)).statusCode).toBe(200);
    const again = await h.request('POST', '/api/store/reset', a, a.owner, { confirmSlug: 'reset-a' });
    expect(again.json()).toMatchObject({ error: { code: 'STEP_UP_REQUIRED' } });
    expect(h.storage.objects.has(otherFiles.uploadKey)).toBe(true);
  });

  it('the worker deletes only files no row points at that were written before the reset', async () => {
    const job = h.storeCleanup.jobs.at(-1)!;
    const resetAt = new Date(job.resetAt).getTime();
    const root = `tenants/${a.id}/`;
    const orphans = [...h.storage.objects.keys()].filter(k => k.startsWith(root));
    expect(orphans.length).toBe(2);
    for (const k of orphans) h.storage.modified.set(k, new Date(resetAt - 1000));
    // a new upload after the reset (row and file), a file written after the reset, and a key outside the two prefixes
    const owner = await h.fixture.prisma.membership.findFirstOrThrow({ where: { tenantId: a.id, role: 'owner' } });
    const newKey = `${root}uploads/${randomUUID()}/original.xlsx`;
    await h.fixture.prisma.upload.create({ data: { tenantId: a.id, source: 'erp', fileName: 'new.xlsx', size: 1, storageKey: newKey, uploadedById: owner.userId, status: 'uploading' } });
    await h.storage.put(newKey, Buffer.from('n')); h.storage.modified.set(newKey, new Date(resetAt - 1000));
    const lateKey = `${root}generated/${randomUUID()}.csv`;
    await h.storage.put(lateKey, Buffer.from('l')); h.storage.modified.set(lateKey, new Date(resetAt + 60_000));
    const otherKey = `${root}exports/keep.txt`;
    await h.storage.put(otherKey, Buffer.from('k')); h.storage.modified.set(otherKey, new Date(resetAt - 1000));

    const details = await cleanStoreStorage({ database: h.fixture.database, storage: h.storage }, job);
    expect(details).toMatchObject({ deleted: 2, failed: 0 });
    for (const k of orphans) expect(h.storage.objects.has(k)).toBe(false);
    for (const k of [newKey, lateKey, otherKey]) expect(h.storage.objects.has(k)).toBe(true);
    expect([...h.storage.objects.keys()].filter(k => k.startsWith(`tenants/${b.id}/`)).length).toBe(2);
    expect(await h.fixture.prisma.auditEvent.count({ where: { tenantId: a.id, action: 'store.storage_cleaned' } })).toBe(1);
    // idempotent: a retry finds nothing more to delete
    expect(await cleanStoreStorage({ database: h.fixture.database, storage: h.storage }, job)).toMatchObject({ deleted: 0 });
  });
});
