import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { Prisma } from '../../../../packages/db/src/generated/client.js';
import { activitySql } from '../../../../packages/db/src/activity.js';
import { ROLE_PERMISSIONS } from '../../../../packages/core/src/roles.js';
import { createHarness, type Harness, type Session, type Store } from './harness.js';

let h: Harness, a: Store, b: Store, analyst: Session, product: string, other: string, actor: string;
const list = (query = '', who = a.owner) => h.request('GET', '/api/activity' + query, a, who);
async function event(action: string, details: Prisma.InputJsonObject, at: string, entityId: string | null = product, actorId: string | null = actor, tenantId = a.id) {
  await h.fixture.prisma.$executeRaw`INSERT INTO audit_events (id, tenant_id, actor_id, entity_id, action, details, created_at)
    VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${actorId}::uuid, ${entityId}::uuid, ${action}, ${JSON.stringify(details)}::jsonb, ${at}::timestamptz)`;
}
beforeAll(async () => {
  h = await createHarness(); a = await h.createOwner('activity-a'); b = await h.createOwner('activity-b'); analyst = await h.member(a, 'analyst');
  actor = (await h.fixture.prisma.user.findFirstOrThrow({ where: { tenantId: a.id, name: 'Owner' } })).id;
  product = (await h.fixture.prisma.product.create({ data: { tenantId: a.id, barcode: '629999900001', normalizedBarcode: '629999900001', nameEn: 'History product', erpPrice: 5 } })).id;
  other = (await h.fixture.prisma.product.create({ data: { tenantId: b.id, barcode: '629999900002', normalizedBarcode: '629999900002', nameEn: 'Other tenant', erpPrice: 1 } })).id;
  await event('product.price_rule_set', { old: null, new: { mode: 'fixed', value: 6 } }, '2026-11-01T10:00:00.123456Z');
  await event('product.price_rule_deleted', { old: { mode: 'fixed', value: 6 } }, '2026-11-01T10:00:00.123457Z');
  await event('pricing.bulk_applied', { changeColumns: ['productId', 'oldMode', 'oldValue', 'newMode', 'newValue', 'oldPrice', 'newPrice'],
    changes: [[product, null, null, 'fixed', 7, 5, 7], [randomUUID(), null, null, 'fixed', 77, 1, 77]], result: { willChange: 2 }, token: 'private-canary' },
    '2026-11-01T10:00:00.123458Z', null);
  await event('product.field_changed', { field: 'erpStock', old: 1, new: 0, uploadId: randomUUID() }, '2026-11-01T11:00:00Z', product, null);
  await event('product.field_changed', { field: 'status', old: 'new', new: 'active' }, '2026-11-01T12:00:00Z');
  await event('product.field_changed', { field: 'costPrice', old: 2, new: 3 }, '2026-11-01T13:00:00Z');
  await event('upload.applied', { uploadId: randomUUID(), updated: 100, passwordHash: 'private-canary', ip: '192.0.2.1' }, '2026-11-01T14:00:00Z', randomUUID());
  await event('product.price_rule_set', { old: null, new: { mode: 'fixed', value: 99 } }, '2026-11-01T15:00:00Z', other, null, b.id);
});
afterAll(async () => { await h.close(); });

describe('activity API and product history', () => {
  it('filters by product/group, preserves microsecond ordering and pages without duplicates', async () => {
    const path = `?productId=${product}&eventType=price&to=2026-11-01T11:00:00Z&limit=1`;
    const types: string[] = [], ids: string[] = []; let cursor: string | null = null;
    do {
      const r = await list(path + (cursor ? '&cursor=' + cursor : '')); expect(r.statusCode).toBe(200);
      const d = r.json().data; expect(d.items).toHaveLength(1); ids.push(d.items[0].id); types.push(d.items[0].type); cursor = d.nextCursor;
    } while (cursor);
    expect(types).toEqual(['pricing.bulk_applied', 'product.price_rule_deleted', 'product.price_rule_set']);
    expect(new Set(ids).size).toBe(3);
  });
  it('filters actors and inclusive date ranges; system actors have an explicit safe label', async () => {
    const d = (await list(`?actorId=system&productId=${product}&from=2026-11-01T11:00:00Z&to=2026-11-01T11:00:00Z`)).json().data;
    expect(d.items).toHaveLength(1); expect(d.items[0].actor).toEqual({ id: null, name: 'system', email: null });
    expect(d.items[0].group).toBe('stock_uploads');
    expect((await list(`?actorId=${actor}&productId=${product}&eventType=catalogue`)).json().data.items.map((r: { type: string }) => r.type)).toEqual(['product.field_changed']);
    const security = (await list('?eventType=team_security')).json().data.items;
    expect(security.length).toBeGreaterThan(0);
    expect(security.every((r: { group: string }) => r.group === 'team_security')).toBe(true);
  });
  it('returns a product-specific bulk diff, activation, and clearly labelled aggregate uploads', async () => {
    const r = await h.request('GET', `/api/products/${product}/history`, a, a.owner); expect(r.statusCode).toBe(200);
    const d = r.json().data;
    expect(d.coverageNotice).toMatch(/store-wide summaries.*do not prove.*Earlier marketplace price/);
    const bulk = d.items.find((x: { type: string }) => x.type === 'pricing.bulk_applied');
    expect(bulk.scope).toBe('product'); expect(bulk.productId).toBe(product);
    expect(bulk.beforeAfter).toContainEqual({ field: 'price', before: 5, after: 7 });
    expect(d.items.find((x: { type: string }) => x.type === 'upload.applied')).toMatchObject({ scope: 'tenant', productId: null });
    expect(r.body).not.toMatch(/private-canary|192\.0\.2\.1|passwordHash|changeColumns|"changes":/);
    expect(d.items.some((x: { beforeAfter: { field: string; after: unknown }[] }) => x.beforeAfter.some(c => c.field === 'status' && c.after === 'active'))).toBe(true);
  });
  it('enforces tenant boundaries, missing products and existing activity permission', async () => {
    expect((await h.request('GET', '/api/activity', a)).statusCode).toBe(401);
    expect((await h.request('GET', '/api/activity', b, a.owner)).statusCode).toBe(401);
    for (const id of [other, randomUUID()]) expect((await h.request('GET', `/api/products/${id}/history`, a, a.owner)).statusCode).toBe(404);
    const permissions = ROLE_PERMISSIONS.analyst;
    ROLE_PERMISSIONS.analyst = permissions.filter(p => p !== 'activity.view');
    try { expect((await list('', analyst)).statusCode).toBe(403); }
    finally { ROLE_PERMISSIONS.analyst = permissions; }
    const d = (await list(`?productId=${product}`, analyst)).json().data;
    expect(d.items.find((x: { summary: string }) => x.summary === 'Cost price changed').beforeAfter).toEqual([]);
  });
  it.each(['?cursor=garbage', '?limit=201', '?eventType=secret', '?actorId=not-uuid', '?from=tomorrow',
    '?from=2026-11-02T00:00:00Z&to=2026-11-01T00:00:00Z', '?tenantId=other'])('rejects invalid filters %s', async q => {
    expect((await list(q)).statusCode).toBe(400);
  });
  it('proves the actual product-history query uses the direct and bulk indexes on PGlite/test data', async () => {
    const indexedProduct = randomUUID();
    await h.fixture.prisma.$executeRaw`INSERT INTO audit_events (id, tenant_id, entity_id, action, details, created_at)
      SELECT gen_random_uuid(), ${a.id}::uuid, CASE WHEN n = 1 THEN ${indexedProduct}::uuid ELSE gen_random_uuid() END,
        'product.field_changed', '{"field":"erpStock","old":1,"new":2}'::jsonb, now() - n * interval '1 second'
      FROM generate_series(1, 12000) n`;
    await h.fixture.prisma.$executeRaw`INSERT INTO audit_events (id, tenant_id, action, details)
      SELECT gen_random_uuid(), ${a.id}::uuid, 'pricing.bulk_applied', jsonb_build_object('changes',
        jsonb_build_array(jsonb_build_array(gen_random_uuid()::text, 'fixed', 1, 'fixed', 2, 1, 2))) FROM generate_series(1, 1200)`;
    await h.fixture.prisma.$executeRaw`INSERT INTO audit_events (id, tenant_id, action, details)
      SELECT gen_random_uuid(), ${a.id}::uuid, 'pricing.bulk_applied', jsonb_build_object('changes',
        jsonb_agg(jsonb_build_array(CASE WHEN n = 1 THEN ${indexedProduct}::text ELSE gen_random_uuid()::text END, 'fixed', 1, 'fixed', 2, 1, 2)))
      FROM generate_series(1, 5000) n`;
    await h.fixture.prisma.$executeRaw`ANALYZE audit_events`;
    const sql = activitySql(a.id, { productId: indexedProduct, includeTenantUploads: true, limit: 10 });
    const explained = await h.fixture.prisma.$queryRaw<{ 'QUERY PLAN': string }[]>(Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) ${sql}`);
    const plan = explained.map(r => r['QUERY PLAN']).join('\n');
    expect(plan).toContain('audit_events_tenant_entity_time_idx');
    expect(plan).toContain('audit_events_bulk_changes_gin_idx');
    const size = await h.fixture.prisma.$queryRaw<{ bytes: bigint }[]>`SELECT pg_relation_size('audit_events_bulk_changes_gin_idx') AS bytes`;
    console.info('ACTIVITY_HISTORY_EXPLAIN\n' + plan + '\nBULK_GIN_BYTES=' + size[0]!.bytes.toString());
    if (process.env.QORLOOP_EXPLAIN_REPORT === '1') {
      await mkdir('.cache/test-results', { recursive: true });
      await writeFile('.cache/test-results/activity-explain.md', '# Product-history EXPLAIN on isolated test data\n\n' +
        'Production query, default planner settings, after ANALYZE. Fixture: 12,000 direct events, 1,200 small bulk events and a 5,000-product bulk event.\n\n' +
        '```text\n' + plan + '\n```\n\nMeasured test GIN size: **' + size[0]!.bytes.toString() + ' bytes**.\n\n' +
        'This proves indexed lookup on this synthetic fixture. It does not establish production PostgreSQL timings or disk requirements. No demo data was used.\n');
    }
  }, 120000);
});
