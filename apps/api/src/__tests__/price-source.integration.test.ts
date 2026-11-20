// Plan step 5 (docs/plans/onboarding-redesign-backend.md): pricing_settings.price_source* (migration 202611200001),
// its CHECK constraint, and the owner-approved backfill (D6) run on seeded stores.
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { AuthService } from '../auth/auth.service.js';
import { createHarness, type Harness } from './harness.js';

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
