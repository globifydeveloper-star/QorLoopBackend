// Plan step 5 (docs/plans/onboarding-redesign-backend.md): pricing_settings.price_source* (migration 202611200001),
// its CHECK constraint, and the owner-approved backfill (D6) run on seeded stores.
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { AuthService } from '../auth/auth.service.js';
import { createHarness, type Harness, type Session, type Store } from './harness.js';

let h: Harness;
beforeAll(async () => { h = await createHarness(); });
afterAll(async () => { await h.close(); });

/** The migration's own backfill statements, after its BACKFILL marker, one statement per call. */
async function backfill() {
  const sql = await readFile('packages/db/prisma/migrations/202611200001_price_source/migration.sql', 'utf8');
  const section = sql.slice(sql.indexOf('-- BACKFILL'));
  const statements = section.split(/;\s*(?:\r?\n|$)/).map(s => s.split(/\r?\n/).filter(l => !l.trim().startsWith('--')).join('\n').trim()).filter(Boolean);
  expect(statements).toHaveLength(3);
  for (const statement of statements) await h.fixture.prisma.$executeRawUnsafe(statement);
}
async function store(slug: string) {
  return (await new AuthService(h.fixture.database, h.config).provision({ name: slug, slug, hostname: slug + '.localhost', ownerEmail: 'owner@' + slug + '.test' })).tenantId;
}
const matched = (tenantId: string) => h.fixture.prisma.reconSummary.create({ data: { tenantId, marketplaceId: 'talabat', hasData: true, listed: 3, computedAt: new Date() } });
const settings = (tenantId: string) => h.fixture.prisma.pricingSettings.findUnique({ where: { tenantId } });

describe('price source columns', () => {
  it('starts unset and the constraint keeps the three columns consistent', async () => {
    const id = await store('ps-check');
    await h.fixture.prisma.pricingSettings.create({ data: { tenantId: id } });
    expect(await settings(id)).toMatchObject({ priceSource: null, priceSourceMarketplaceId: null, priceSourceConfirmedAt: null });
    for (const data of [
      { priceSource: 'adopt', priceSourceConfirmedAt: new Date() },
      { priceSource: 'erp_markup', priceSourceMarketplaceId: 'talabat', priceSourceConfirmedAt: new Date() },
      { priceSource: 'erp_markup' },
      { priceSource: 'something', priceSourceConfirmedAt: new Date() },
      { priceSourceConfirmedAt: new Date() },
    ]) {
      const accepted = await h.fixture.prisma.pricingSettings.update({ where: { tenantId: id }, data }).then(() => true, () => false);
      expect({ data, accepted }).toEqual({ data, accepted: false });
    }
    await h.fixture.prisma.pricingSettings.update({ where: { tenantId: id }, data: { priceSource: 'adopt', priceSourceMarketplaceId: 'snoonu', priceSourceConfirmedAt: new Date() } });
    await expect(h.fixture.prisma.pricingSettings.update({ where: { tenantId: id }, data: { priceSourceMarketplaceId: 'nowhere' } })).rejects.toThrow();
  });
});

describe('backfill for existing stores (D6)', () => {
  it('confirms stores with matched data and leaves new stores to onboarding', async () => {
    const adopted = await store('ps-adopted'), working = await store('ps-working'), fresh = await store('ps-fresh'), unmatched = await store('ps-unmatched');
    for (const id of [adopted, working]) await matched(id);
    await h.fixture.prisma.reconSummary.create({ data: { tenantId: unmatched, marketplaceId: 'talabat', hasData: true, listed: 0, computedAt: new Date() } });
    await h.fixture.prisma.pricingSettings.create({ data: { tenantId: adopted, defaultRuleMode: 'percent', defaultRuleValue: 10 } });
    const older = new Date(Date.now() - 86_400_000), newer = new Date(Date.now() - 3_600_000);
    await h.fixture.prisma.auditEvent.createMany({ data: [
      { tenantId: adopted, action: 'pricing.prices_adopted', details: { sourceMarketplaceId: 'talabat' }, createdAt: older },
      { tenantId: adopted, action: 'pricing.prices_adopted', details: { sourceMarketplaceId: 'snoonu' }, createdAt: newer },
      // Another store's adoption never leaks across; an unknown marketplace id is ignored.
      { tenantId: fresh, action: 'pricing.prices_adopted', details: { sourceMarketplaceId: 'talabat' } },
      { tenantId: working, action: 'pricing.prices_adopted', details: { sourceMarketplaceId: 'unknown' } },
    ] });

    await backfill();

    expect(await settings(adopted)).toMatchObject({ priceSource: 'adopt', priceSourceMarketplaceId: 'snoonu', priceSourceConfirmedAt: newer, defaultRuleMode: 'percent' });
    // No pricing row before: one is created with the defaults, as 'ERP price plus markup' (0 %).
    expect(await settings(working)).toMatchObject({ priceSource: 'erp_markup', priceSourceMarketplaceId: null, defaultRuleMode: 'same' });
    expect((await settings(working))!.priceSourceConfirmedAt).toBeInstanceOf(Date);
    expect(await settings(fresh)).toBeNull();
    expect(await settings(unmatched)).toBeNull();

    // Running it again changes nothing (migrations run once, but the statements are idempotent anyway).
    const before = await h.fixture.prisma.pricingSettings.findMany({ orderBy: { tenantId: 'asc' } });
    await backfill();
    expect(await h.fixture.prisma.pricingSettings.findMany({ orderBy: { tenantId: 'asc' } })).toEqual(before);
  });
});

describe('GET/PUT /api/pricing/price-source (plan steps 8-9)', () => {
  let serial = 0;
  async function seed(store: Store, marketplaceId = 'talabat') {
    const user = await h.fixture.prisma.user.findFirstOrThrow({ where: { tenantId: store.id } });
    await h.fixture.prisma.upload.create({ data: { tenantId: store.id, source: marketplaceId, fileName: 'm.xlsx', size: 1, storageKey: 'ps-' + store.id + marketplaceId, uploadedById: user.id, status: 'applied', appliedAt: new Date() } });
    for (const [name, erp, listed] of [['Milk', 4, 5.75], ['Bread', 2, 2.5], ['Unlisted', 3, null]] as const) {
      const barcode = String(6_287_000_000_000 + ++serial);
      const p = await h.fixture.prisma.product.create({ data: { tenantId: store.id, nameEn: name, barcode, normalizedBarcode: barcode, erpPrice: erp, erpStock: 5, status: 'active' } });
      if (listed !== null) await h.fixture.prisma.listing.create({ data: { tenantId: store.id, marketplaceId, marketplaceProductId: marketplaceId + barcode, productId: p.id, barcodes: [barcode], price: listed, available: true } });
    }
  }
  const put = (store: Store, body: Record<string, unknown>, who: Session = store.owner) => h.request('PUT', '/api/pricing/price-source', store, who, body);
  const get = (store: Store, who: Session = store.owner) => h.request('GET', '/api/pricing/price-source', store, who);
  const events = (store: Store, action: string) => h.fixture.prisma.auditEvent.findMany({ where: { tenantId: store.id, action }, orderBy: { createdAt: 'asc' } });
  const previewToken = async (store: Store, body: Record<string, unknown> = {}) => {
    const r = await h.request('POST', '/api/pricing/adopt/preview', store, store.owner, { sourceMarketplaceId: 'talabat', scope: { all: true }, ...body });
    expect(r.statusCode).toBe(200);
    return r.json().data.previewToken as string;
  };

  it('ERP price plus markup: writes the default rule and records the choice once', async () => {
    const s = await h.createOwner('ps-markup');
    expect((await get(s)).json().data).toEqual({ source: null, marketplaceId: null, confirmedAt: null });
    const calls = h.recon.calls.length;
    const r = await put(s, { source: 'erp_markup', rule: { mode: 'percent', value: 15 }, rounding: '0.25' });
    expect(r.statusCode).toBe(200);
    expect(r.json().data).toMatchObject({ priceSource: { source: 'erp_markup', marketplaceId: null }, pricing: { defaultRule: { mode: 'percent', value: 15 }, rounding: '0.25' }, adopted: null });
    expect((await get(s)).json().data.confirmedAt).not.toBeNull();
    expect((await events(s, 'pricing.price_source_set')).map(e => e.details)).toEqual([{ old: null, new: { source: 'erp_markup', marketplaceId: null } }]);
    expect((await events(s, 'pricing.settings_changed')).map(e => (e.details as { field: string }).field).sort()).toEqual(['defaultRule', 'rounding']);
    expect(h.recon.calls.slice(calls)).toEqual([{ tenantId: s.id, reason: 'pricing.price_source' }]);

    // Saving the same again writes nothing and recomputes nothing.
    expect((await put(s, { source: 'erp_markup', rule: { mode: 'percent', value: 15 }, rounding: '0.25' })).statusCode).toBe(200);
    expect(await events(s, 'pricing.price_source_set')).toHaveLength(1);
    expect(h.recon.calls.length).toBe(calls + 1);
  });
  it('accepts the ERP price as it is (the defaults) as a deliberate choice', async () => {
    const s = await h.createOwner('ps-same');
    const calls = h.recon.calls.length;
    const r = await put(s, { source: 'erp_markup', rule: { mode: 'same' } });
    expect(r.statusCode).toBe(200);
    expect(r.json().data.priceSource.source).toBe('erp_markup');
    expect(await events(s, 'pricing.settings_changed')).toHaveLength(0);
    expect(h.recon.calls.length).toBe(calls);
  });
  it('validates the body and allows Owner and Admin only (D7)', async () => {
    const s = await h.createOwner('ps-roles');
    for (const body of [{ source: 'erp_markup', rule: { mode: 'fixed', value: 5 } }, { source: 'erp_markup', rule: { mode: 'percent', value: 2000 } },
      { source: 'erp_markup' }, { source: 'other' }, { source: 'adopt', sourceMarketplaceId: 'talabat' }, { source: 'adopt', sourceMarketplaceId: 'talabat', previewToken: 'x' }]) {
      expect((await put(s, body)).statusCode).toBe(400);
    }
    const markup = { source: 'erp_markup', rule: { mode: 'amount', value: 1 } };
    expect((await put(s, markup, await h.member(s, 'catalogue_manager'))).statusCode).toBe(403);
    expect((await put(s, markup, await h.member(s, 'analyst'))).statusCode).toBe(403);
    expect((await get(s)).json().data.source).toBeNull();
    expect((await put(s, markup, await h.member(s, 'admin'))).statusCode).toBe(200);
  });
  it('adopt: applies exactly the previewed whole-catalogue adoption from an enabled marketplace with a file', async () => {
    const s = await h.createOwner('ps-adopt');
    await seed(s);
    const revision = (await h.request('GET', '/api/settings', s, s.owner)).json().data.revision;
    expect((await h.request('PUT', '/api/settings/marketplaces', s, s.owner, { expectedRevision: revision, enabled: ['talabat', 'snoonu'] })).statusCode).toBe(200);
    const token = await previewToken(s);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(await previewToken(s)).toBe(token);
    expect(await previewToken(s, { mode: 'percent' })).not.toBe(token);

    const disabled = await put(s, { source: 'adopt', sourceMarketplaceId: 'keeta', previewToken: token });
    expect(disabled.statusCode).toBe(400);
    expect(disabled.json().error.details).toEqual([{ path: 'sourceMarketplaceId', message: 'Keeta is not enabled for this store' }]);
    expect((await put(s, { source: 'adopt', sourceMarketplaceId: 'snoonu', previewToken: token })).json().error.details[0].message).toBe('Upload and apply a Snoonu file first');
    expect((await put(s, { source: 'adopt', sourceMarketplaceId: 'talabat', previewToken: 'f'.repeat(64) })).statusCode).toBe(409);
    expect((await put(s, { source: 'adopt', sourceMarketplaceId: 'talabat', mode: 'percent', previewToken: token })).statusCode).toBe(409);
    expect(await h.fixture.prisma.productPriceRule.count({ where: { tenantId: s.id } })).toBe(0);

    const calls = h.recon.calls.length;
    const r = await put(s, { source: 'adopt', sourceMarketplaceId: 'talabat', previewToken: token });
    expect(r.statusCode).toBe(200);
    expect(r.json().data).toMatchObject({ priceSource: { source: 'adopt', marketplaceId: 'talabat' }, adopted: { products: 3, adopted: 2, skipped: { no_listing: 1 } } });
    expect((await h.fixture.prisma.productPriceRule.findMany({ where: { tenantId: s.id } })).map(x => [x.mode, x.value.toNumber()]).sort()).toEqual([['fixed', 2.5], ['fixed', 5.75]]);
    expect(await events(s, 'pricing.prices_adopted')).toHaveLength(1);
    expect((await events(s, 'pricing.price_source_set')).map(e => e.details)).toEqual([{ old: null, new: { source: 'adopt', marketplaceId: 'talabat' } }]);
    expect(h.recon.calls.slice(calls)).toEqual([{ tenantId: s.id, reason: 'pricing.adopt' }]);

    // The same token cannot be replayed: the plan has changed (every product now has its rule).
    expect((await put(s, { source: 'adopt', sourceMarketplaceId: 'talabat', previewToken: token })).statusCode).toBe(409);

    // Switching to ERP plus markup later is recorded; adopted product rules stay (they outrank the default rule).
    expect((await put(s, { source: 'erp_markup', rule: { mode: 'percent', value: 20 } })).statusCode).toBe(200);
    expect((await events(s, 'pricing.price_source_set')).at(-1)!.details).toEqual({ old: { source: 'adopt', marketplaceId: 'talabat' }, new: { source: 'erp_markup', marketplaceId: null } });
    expect(await h.fixture.prisma.productPriceRule.count({ where: { tenantId: s.id } })).toBe(2);
  });
  it('adopt/apply over the whole catalogue answers the price question for an Owner or Admin, not for others (D5, D7)', async () => {
    const owner = await h.createOwner('ps-d5-owner');
    await seed(owner);
    expect((await h.request('POST', '/api/pricing/adopt/apply', owner, owner.owner, { sourceMarketplaceId: 'talabat', scope: { all: true } })).statusCode).toBe(200);
    expect((await get(owner)).json().data).toMatchObject({ source: 'adopt', marketplaceId: 'talabat' });

    const managed = await h.createOwner('ps-d5-manager');
    await seed(managed);
    const manager = await h.member(managed, 'catalogue_manager');
    expect((await h.request('POST', '/api/pricing/adopt/apply', managed, manager, { sourceMarketplaceId: 'talabat', scope: { all: true } })).statusCode).toBe(200);
    expect((await get(managed)).json().data.source).toBeNull();
    expect(await h.fixture.prisma.productPriceRule.count({ where: { tenantId: managed.id } })).toBe(2);
  });
});
