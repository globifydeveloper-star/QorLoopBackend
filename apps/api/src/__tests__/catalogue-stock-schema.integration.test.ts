import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { testDatabase } from './database.js';

/** Migration 202611060001_erp_changes_catalogue_stock on the embedded database: constraints, cascades and policies. */
let db: Awaited<ReturnType<typeof testDatabase>>;
let tenantId: string, userId: string, productId: string, uploadId: string;

beforeAll(async () => {
  db = await testDatabase();
  const t = await db.database.initialize({ name: 'schema', slug: 'schema', hostname: 'schema.localhost' });
  tenantId = t.id;
  userId = (await db.prisma.user.create({ data: { tenantId, email: 'o@schema.test', name: 'O', passwordHash: 'x', emailVerifiedAt: new Date() } })).id;
  productId = (await db.prisma.product.create({ data: { tenantId, barcode: '6281000000011', normalizedBarcode: '6281000000011', nameEn: 'Laban', erpPrice: 1, erpStock: 5 } })).id;
  uploadId = (await db.prisma.upload.create({ data: { tenantId, source: 'erp', fileName: 'e.xlsx', size: 10, storageKey: 'k1', uploadedById: userId, status: 'applied' } })).id;
});
afterAll(async () => { await db.close(); });

const change = (o: Record<string, unknown> = {}) => ({ tenantId, uploadId, productId, rowNumber: 2, barcode: '6281000000011', kind: 'stock', field: 'erpStock', oldValue: 5, newValue: 7, ...o });
const edit = (o: Record<string, unknown> = {}) => ({ tenantId, productId, stock: 3, erpStockAtEdit: 5, setById: userId, setAt: new Date(), ...o });

describe('erp_upload_changes', () => {
  it('accepts the shapes the apply writes', async () => {
    await db.prisma.erpUploadChange.create({ data: change() });
    await db.prisma.erpUploadChange.create({ data: change({ kind: 'new', field: null, oldValue: undefined, newValue: undefined }) });
    await db.prisma.erpUploadChange.create({ data: change({ kind: 'missing', field: 'inLatestErpFile', rowNumber: null, oldValue: true, newValue: false }) });
    await db.prisma.erpUploadChange.create({ data: change({ stockConflict: true }) });
    expect(await db.prisma.erpUploadChange.count({ where: { tenantId, uploadId } })).toBe(4);
  });
  it.each([
    [{ kind: 'bogus' }, 'unknown kind'],
    [{ field: 'status' }, 'a Qorloop-owned field'],
    [{ kind: 'new' }, 'new with a field'],
    [{ field: null }, 'a field change without a field'],
    [{ rowNumber: null }, 'no row number outside missing'],
    [{ kind: 'price', field: 'erpPrice', stockConflict: true }, 'a stock conflict on a price change'],
  ])('refuses %j (%s)', async o => {
    await expect(db.prisma.erpUploadChange.create({ data: change(o) })).rejects.toThrow();
  });
  it('a product of another tenant cannot be referenced (composite foreign key)', async () => {
    const other = await db.database.initialize({ name: 'schema2', slug: 'schema2', hostname: 'schema2.localhost' });
    await expect(db.prisma.erpUploadChange.create({ data: change({ tenantId: other.id }) })).rejects.toThrow();
  });
});

describe('catalogue_stock_edits', () => {
  it('one edit per product; timestamps keep millisecond precision', async () => {
    const at = new Date('2026-11-06T10:00:00.123Z');
    const e = await db.prisma.catalogueStockEdit.create({ data: edit({ setAt: at }) });
    expect(e.setAt.toISOString()).toBe('2026-11-06T10:00:00.123Z');
    await expect(db.prisma.catalogueStockEdit.create({ data: edit() })).rejects.toThrow();
    // stored at (3): a raw now() write is cut to milliseconds by the column type
    const [row] = await db.prisma.$queryRaw<{ us: number }[]>`
      UPDATE catalogue_stock_edits SET updated_at = now() WHERE id = ${e.id}::uuid RETURNING (extract(microseconds FROM updated_at)::bigint % 1000)::int AS us`;
    expect(row!.us).toBe(0);
    await db.prisma.catalogueStockEdit.delete({ where: { id: e.id } });
  });
  it.each([
    [{ stock: -1 }, 'negative stock'],
    [{ erpStockAtEdit: -1 }, 'negative base'],
    [{ state: 'pending' }, 'unknown state'],
    [{ state: 'conflict' }, 'a conflict without its upload and time'],
    [{ conflictUploadId: randomUUID(), conflictAt: new Date() }, 'conflict fields on an active edit'],
    [{ reason: 'x'.repeat(501) }, 'a reason over 500 characters'],
  ])('refuses %j (%s)', async o => {
    await expect(db.prisma.catalogueStockEdit.create({ data: edit(o) })).rejects.toThrow();
  });
  it('accepts a conflict with its upload and time', async () => {
    const e = await db.prisma.catalogueStockEdit.create({ data: edit({ state: 'conflict', conflictUploadId: uploadId, conflictAt: new Date() }) });
    await db.prisma.catalogueStockEdit.delete({ where: { id: e.id } });
  });
});

describe('migration side effects', () => {
  it('deleting an upload removes its change rows', async () => {
    const u = await db.prisma.upload.create({ data: { tenantId, source: 'erp', fileName: 'e.xlsx', size: 10, storageKey: 'k2', uploadedById: userId } });
    await db.prisma.erpUploadChange.create({ data: change({ uploadId: u.id }) });
    await db.prisma.upload.delete({ where: { id: u.id } });
    expect(await db.prisma.erpUploadChange.count({ where: { uploadId: u.id } })).toBe(0);
  });
  it('the new tables carry the same tenant_isolation policy as every other tenant table (defined, not enabled)', async () => {
    const policies = await db.prisma.$queryRaw<{ tablename: string; policyname: string; qual: string }[]>`
      SELECT tablename::text, policyname::text, qual FROM pg_policies WHERE tablename IN ('erp_upload_changes', 'catalogue_stock_edits', 'products') ORDER BY tablename`;
    expect(policies.map(p => [p.tablename, p.policyname])).toEqual([
      ['catalogue_stock_edits', 'tenant_isolation'], ['erp_upload_changes', 'tenant_isolation'], ['products', 'tenant_isolation'],
    ]);
    expect(new Set(policies.map(p => p.qual)).size).toBe(1);
    const rls = await db.prisma.$queryRaw<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT relname::text, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('erp_upload_changes', 'catalogue_stock_edits', 'products') ORDER BY relname`;
    expect(rls.every(r => !r.relrowsecurity && !r.relforcerowsecurity)).toBe(true);
  });
  it('recon_rows has the two new nullable columns with a valid-value check', async () => {
    const cols = await db.prisma.$queryRaw<{ column_name: string; is_nullable: string }[]>`
      SELECT column_name::text, is_nullable::text FROM information_schema.columns WHERE table_name = 'recon_rows' AND column_name IN ('catalogue_available', 'stock_issue_vs_erp') ORDER BY column_name`;
    expect(cols).toEqual([{ column_name: 'catalogue_available', is_nullable: 'YES' }, { column_name: 'stock_issue_vs_erp', is_nullable: 'YES' }]);
    await expect(db.prisma.reconRow.create({ data: { tenantId, productId, marketplaceId: 'talabat', status: 'in_sync', stockIssueVsErp: 'bogus' } })).rejects.toThrow();
  });
});
