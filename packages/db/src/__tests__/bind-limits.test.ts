import { describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { Prisma } from '../generated/client.js';
import { UploadRepository } from '../uploads.js';
import type { NewProduct, ProductWrite } from '../../../core/src/upload/apply.js';

/** The Postgres wire protocol counts bind parameters in an Int16: a statement with more is refused. */
const PG_MAX_BIND_PARAMS = 65_535;

/** Columns of a model as the generated client knows them; Prisma binds at most one value per column per row. */
const columns = (model: string) =>
  Object.keys((Prisma as unknown as Record<string, object>)[model[0]!.toUpperCase() + model.slice(1) + 'ScalarFieldEnum']!).length;

/** A transaction that records the bind-parameter count of every statement instead of running it. */
function recordingTx() {
  const statements: { what: string; params: number }[] = [];
  const raw = (what: string) => (_s: TemplateStringsArray, ...values: unknown[]) => { statements.push({ what, params: values.length }); return Promise.resolve([]); };
  const tx = new Proxy({} as Record<string, unknown>, {
    get(_t, model: string) {
      if (model === '$executeRaw') return raw(model);
      if (model === '$queryRaw') return raw(model);
      return {
        createMany: ({ data }: { data: unknown[] }) => { statements.push({ what: `${model}.createMany`, params: data.length * columns(model) }); return Promise.resolve({ count: data.length }); },
        deleteMany: () => Promise.resolve({ count: 0 }),
      };
    },
  });
  return { tx: tx as unknown as ConstructorParameters<typeof UploadRepository>[1], statements };
}

const product = (i: number): ProductWrite => ({
  id: randomUUID(), sku: `SKU-${i}`, nameEn: `Product ${i}`, nameAr: null, brand: 'Brand', erpCategory: 'Dairy',
  erpPrice: 1.5, costPrice: 1, erpStock: i, erpActive: true, inLatestErpFile: true,
});

describe('bulk statements stay under the Postgres bind-parameter limit', () => {
  it('the real column counts: what the generated client says each bulk-written table has', () => {
    // If a migration adds columns, these move and the next test re-checks every batch against them.
    expect(columns('product')).toBeGreaterThanOrEqual(20);
    expect(columns('uploadRow')).toBe(7);
    expect(columns('uploadError')).toBeGreaterThanOrEqual(6);
    expect(columns('auditEvent')).toBe(8);
    // the counter is not toothless: the old product createMany at 5,000 rows would be refused by real Postgres
    expect(5000 * columns('product')).toBeGreaterThan(PG_MAX_BIND_PARAMS);
  });

  it('every statement of a 50,000-row review and a 50,000-row apply binds at most 65,535 parameters', async () => {
    const { tx, statements } = recordingTx();
    const repo = new UploadRepository(randomUUID(), tx);
    const n = 50_000;
    await repo.replaceReview(
      randomUUID(),
      Array.from({ length: n }, (_, i) => ({ rowNumber: i + 2, parsed: { data: { i } }, matchProductId: null, changeType: 'new' })),
      Array.from({ length: n }, (_, i) => ({ row: i + 2, column: 'Price', value: 'x', reason: 'Not a number' })),
    );
    await repo.createProducts(Array.from({ length: n }, (_, i): NewProduct => {
      const { id: _id, inLatestErpFile: _flag, ...p } = product(i);
      return { ...p, normalizedBarcode: String(6290000000000 + i), status: 'new' };
    }));
    await repo.updateProducts(Array.from({ length: n }, (_, i) => product(i)));
    await repo.flagMissingProducts(Array.from({ length: n }, (_, i) => String(6290000000000 + i)));
    await repo.upsertListings('snoonu', randomUUID(), Array.from({ length: n }, (_, i) => ({
      marketplaceProductId: `MP-${i}`, productId: null, barcodes: [String(i)], name: `Listing ${i}`, price: 2, available: true,
    })));
    await repo.removeListingsNotIn('snoonu', Array.from({ length: n }, (_, i) => `MP-${i}`));
    await repo.auditEvents(null, Array.from({ length: n * 3 }, () => ({ action: 'product.field_changed', entityId: randomUUID(), details: { field: 'erpPrice', old: 1, new: 2 } })));

    expect(statements.length).toBeGreaterThan(10);
    const over = statements.filter(s => s.params > PG_MAX_BIND_PARAMS);
    expect(over).toEqual([]);
  });
});
