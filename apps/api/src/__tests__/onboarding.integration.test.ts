import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { generate } from 'otplib';
import { createHarness, password, type Harness, type Session, type Store } from './harness.js';
import { AuthService } from '../auth/auth.service.js';
import { hashPassword, unseal } from '../../../../packages/shared/src/security.js';
import type { OnboardingProgress } from '../../../../packages/core/src/onboarding.js';
import { processUpload } from '../../../worker/src/process-upload.js';
import { applyUpload } from '../../../worker/src/apply-upload.js';
import { recomputeRecon } from '../../../worker/src/recompute-recon.js';
import { generateFile } from '../../../worker/src/generate-file.js';
import { barcodes, marketplaceWorkbook, talabatHeaders, talabatMapping, talabatRows, snoonuHeaders, snoonuMapping, snoonuRows } from '../../../../packages/core/src/__tests__/fixtures/marketplace-files.js';

let h: Harness, a: Store, b: Store, admin: Session, pendingOwner: Session;
let ownerId: string;
const get = async (store = a, session = admin) => {
  const response = await h.request('GET', '/api/onboarding', store, session);
  expect(response.statusCode).toBe(200);
  return response.json().data as OnboardingProgress;
};
const status = (p: OnboardingProgress, id: string) => p.steps.find(s => s.id === id)!;

/** Real upload workers and API; recon is deliberately computed separately to observe that transition. */
async function prepareFile(source: string, data: Buffer, fields: Record<string, string>) {
  const created = await h.request('POST', '/api/uploads', a, a.owner, { source, fileName: source + '.xlsx', size: data.length });
  expect(created.statusCode).toBe(200);
  const id = created.json().data.id as string;
  const row = await h.fixture.prisma.upload.findUniqueOrThrow({ where: { id } });
  await h.storage.put(row.storageKey, data);
  expect((await h.request('POST', `/api/uploads/${id}/complete`, a, a.owner)).statusCode).toBe(200);
  if ((await h.request('GET', `/api/uploads/${id}`, a, a.owner)).json().data.status === 'needs_mapping') {
    expect((await h.request('POST', `/api/uploads/${id}/mapping`, a, a.owner, { fields })).statusCode).toBe(200);
  }
  expect((await h.request('GET', `/api/uploads/${id}`, a, a.owner)).json().data.status).toBe('needs_review');
  return id;
}
async function apply(id: string) {
  expect((await h.request('POST', `/api/uploads/${id}/apply`, a, a.owner)).statusCode).toBe(200);
  expect((await h.fixture.prisma.upload.findUniqueOrThrow({ where: { id } })).status).toBe('applied');
  await h.recon.drain();
}

beforeAll(async () => {
  h = await createHarness();
  const deps = { database: h.fixture.database, storage: h.storage };
  h.queue.handler = job => processUpload(deps, job).then(() => undefined);
  h.queue.applyHandler = job => applyUpload({ ...deps, recon: h.recon }, job).then(() => undefined);
  h.generatedFiles.handler = job => generateFile(deps, job);
  const provision = await new AuthService(h.fixture.database, h.config).provision({ name: 'New shop', slug: 'onboarding-a', hostname: 'onboarding-a.localhost', ownerEmail: 'owner@onboarding-a.test' });
  a = { id: provision.tenantId, hostname: 'onboarding-a.localhost', owner: {} as Session };
  // An admin observer lets us inspect a truly new shop before its Owner has enrolled MFA.
  // This fixture does not create an invitation and therefore cannot satisfy the team step.
  await h.fixture.database.run(a.id, async data => {
    const user = await data.createUser({ name: 'Admin', email: 'admin@onboarding-a.test', passwordHash: await hashPassword(password), emailVerifiedAt: new Date() });
    await data.createMembership(user.id, 'admin');
  });
  admin = h.sessionFrom(await h.request('POST', '/api/auth/login', a, undefined, { email: 'admin@onboarding-a.test', password }));
  const mail = await h.fixture.prisma.emailOutbox.findFirstOrThrow({ where: { tenantId: a.id } });
  const plaintext = await unseal<{ text: string }>(mail.sealedMessage, h.config.AUTH_SECRET);
  const token = plaintext.text.match(/#token=([A-Za-z0-9_-]+)/)![1];
  pendingOwner = h.sessionFrom(await h.request('POST', '/api/auth/invitations/accept', a, undefined, { token, name: 'Owner', password }));
  ownerId = (await h.fixture.prisma.user.findFirstOrThrow({ where: { tenantId: a.id, name: 'Owner' } })).id;
  b = await h.createOwner('onboarding-b');
}, 120_000);
afterAll(async () => { await h?.close(); });

describe('GET /api/onboarding', () => {
  it('starts with no evidence, initial Owner invitation excluded, and preserves the MFA gate', async () => {
    const p = await get();
    expect(p).toMatchObject({ percent: 0, complete: false, nextStepId: 'owner_mfa' });
    expect(p.steps.map(s => s.status)).toEqual(['next', 'todo', 'todo', 'todo', 'todo', 'todo', 'todo']);
    expect(p.steps.every(s => s.doneAt === null)).toBe(true);
    expect(p.marketplaces.every(m => !m.applied && m.doneAt === null)).toBe(true);
    expect((await h.request('GET', '/api/onboarding', a, pendingOwner)).statusCode).toBe(403);
    expect((await h.request('GET', '/api/onboarding', a)).statusCode).toBe(401);
  });

  it('advances only after real MFA enrollment, ERP apply, marketplace apply and computed comparison', async () => {
    const setup = await h.request('POST', '/api/auth/mfa/setup', a, pendingOwner, { password });
    expect(setup.statusCode).toBe(200);
    expect(status(await get(), 'owner_mfa').status).toBe('next');
    const secret = new URL(setup.json().data.totpUri).searchParams.get('secret')!;
    a.owner = h.sessionFrom(await h.request('POST', '/api/auth/mfa/verify', a, pendingOwner, { code: await generate({ secret }) }));
    let p = await get(a, a.owner);
    expect(p).toMatchObject({ percent: 25, nextStepId: 'erp_upload' });
    expect(status(p, 'owner_mfa')).toMatchObject({ status: 'done', doneAt: null });

    const erp = await prepareFile('erp', await marketplaceWorkbook(['Barcode', 'Item Name', 'Sale Price', 'Qty'], [[barcodes[0], 'Milk', 2, 5]]), { barcode: 'Barcode', nameEn: 'Item Name', price: 'Sale Price', stock: 'Qty' });
    expect(status(await get(), 'erp_upload').status).toBe('next');
    await apply(erp);
    p = await get();
    expect(p).toMatchObject({ percent: 50, nextStepId: 'marketplace_upload' });
    expect(status(p, 'erp_upload').doneAt).toBe((await h.fixture.prisma.upload.findUniqueOrThrow({ where: { id: erp } })).appliedAt!.toISOString());

    // ERP products start as new. Activation represents an existing catalogue operation, not onboarding storage.
    await h.fixture.prisma.product.updateMany({ where: { tenantId: a.id }, data: { status: 'active' } });
    const talabat = await prepareFile('talabat', await marketplaceWorkbook(talabatHeaders, [talabatRows[0]]), talabatMapping);
    expect(status(await get(), 'marketplace_upload').status).toBe('next');
    await apply(talabat);
    p = await get();
    expect(p).toMatchObject({ percent: 75, complete: false, nextStepId: 'first_comparison' });
    expect(p.marketplaces[0]).toMatchObject({ marketplaceId: 'talabat', applied: true });
    expect(status(p, 'first_comparison').doneAt).toBeNull();

    await recomputeRecon({ database: h.fixture.database }, { tenantId: a.id, reason: 'manual' });
    p = await get();
    expect(p).toMatchObject({ percent: 100, complete: true, nextStepId: null });
    expect(p.steps.slice(0, 4).every(s => s.status === 'done')).toBe(true);
    expect(p.steps.slice(4).every(s => s.status === 'todo')).toBe(true);

    const snoonu = await prepareFile('snoonu', await marketplaceWorkbook(snoonuHeaders, [snoonuRows[0]]), snoonuMapping);
    await apply(snoonu);
    p = await get();
    expect(p.marketplaces.slice(0, 2).every(m => m.applied && m.doneAt !== null)).toBe(true);
    expect(p).toMatchObject({ percent: 100, complete: true, nextStepId: null });
    for (const step of p.steps) if (step.doneAt) expect(new Date(step.doneAt).toISOString()).toBe(step.doneAt);
  }, 120_000);

  it('leaves pricing optional until settings differ from defaults, and derives the other optional steps', async () => {
    const before = await h.fixture.prisma.auditEvent.count({ where: { tenantId: a.id } });
    expect((await h.request('GET', '/api/pricing/settings', a, a.owner)).statusCode).toBe(200);
    expect((await h.request('PUT', '/api/pricing/settings', a, a.owner, { defaultRule: { mode: 'same' }, rounding: 'exact' })).statusCode).toBe(200);
    expect(status(await get(), 'pricing_settings').status).toBe('todo');
    expect(await h.fixture.prisma.auditEvent.count({ where: { tenantId: a.id } })).toBe(before);

    expect((await h.request('PUT', '/api/pricing/settings', a, a.owner, { rounding: '0.25' })).statusCode).toBe(200);
    expect(status(await get(), 'pricing_settings').status).toBe('done');
    expect((await h.request('PUT', '/api/pricing/settings', a, a.owner, { rounding: 'exact' })).statusCode).toBe(200);
    expect(status(await get(), 'pricing_settings').status).toBe('todo');
    expect((await h.request('PUT', '/api/pricing/settings', a, a.owner, { marketplaceRules: [{ marketplaceId: 'snoonu', mode: 'amount', value: 1, rounding: 'exact' }] })).statusCode).toBe(200);
    expect(status(await get(), 'pricing_settings').status).toBe('done');

    const invited = await h.request('POST', '/api/team/invitations', a, a.owner, { email: 'teammate@onboarding-a.test', role: 'analyst' });
    expect(invited.statusCode).toBe(200);
    expect(status(await get(), 'invite_team').status).toBe('done');
    // This is evidence of having sent an invitation, not a live pending-invitation count.
    await h.fixture.prisma.invitation.update({ where: { id: invited.json().data.id }, data: { revokedAt: new Date(), pendingEmail: null } });
    expect(status(await get(), 'invite_team').status).toBe('done');

    await h.recon.drain();
    const queued = await h.request('POST', '/api/generated-files', a, a.owner, { marketplaceId: 'talabat', kind: 'price', reference: 'erp' });
    expect(queued.statusCode).toBe(202);
    const file = await h.fixture.prisma.generatedFile.findFirstOrThrow({ where: { tenantId: a.id } });
    const p = await get();
    expect(status(p, 'generated_file')).toMatchObject({ status: 'done', doneAt: file.generatedAt.toISOString() });
    expect(p).toMatchObject({ percent: 100, complete: true, nextStepId: null });
  }, 120_000);

  it('isolates tenants, returns empty progress to operational roles, and never includes secrets', async () => {
    const untouched = await get(b, b.owner);
    expect(untouched).toMatchObject({ percent: 25, nextStepId: 'erp_upload', complete: false });
    expect(untouched.steps.filter(s => s.status === 'done').map(s => s.id)).toEqual(['owner_mfa']);
    expect((await h.request('GET', '/api/onboarding', b, a.owner)).statusCode).toBe(401);
    expect((await h.request('GET', '/api/onboarding', { hostname: 'missing.localhost' }, a.owner)).statusCode).toBe(404);
    for (const role of ['catalogue_manager', 'analyst']) {
      const member = await h.member(b, role);
      expect(await get(b, member)).toEqual({ steps: [], percent: 0, nextStepId: null, complete: false, marketplaces: [] });
    }
    const response = await h.request('GET', '/api/onboarding', a, admin);
    expect(response.body).not.toMatch(/password|mfaSecret|pendingMfa|token|csrf|storageKey|sealedMessage|owner@|admin@/i);
    const owner = await h.fixture.prisma.user.findUniqueOrThrow({ where: { id: ownerId } });
    expect(response.body).not.toContain(owner.passwordHash);
    expect(response.body).not.toContain(owner.mfaSecret!);
    expect(Object.keys(response.json())).toEqual(['data']);
    expect(Object.keys(response.json().data).sort()).toEqual(['complete', 'marketplaces', 'nextStepId', 'percent', 'steps']);
  });

  it('ignores empty/uncomputed summaries and non-applied uploads, and exports the actual GET contract only', async () => {
    const user = await h.fixture.prisma.user.findFirstOrThrow({ where: { tenantId: b.id } });
    await h.fixture.prisma.upload.create({ data: { tenantId: b.id, source: 'erp', status: 'needs_review', fileName: 'not-applied.xlsx', size: 1, storageKey: 'test/not-applied', uploadedById: user.id } });
    await h.fixture.prisma.upload.create({ data: { tenantId: b.id, source: 'talabat', status: 'failed', appliedAt: new Date(), fileName: 'failed.xlsx', size: 1, storageKey: 'test/failed', uploadedById: user.id } });
    const summary = await h.fixture.prisma.reconSummary.create({ data: { tenantId: b.id, marketplaceId: 'talabat', reference: 'marketplace', hasData: true, computedAt: new Date(), listed: 0 } });
    expect(status(await get(b, b.owner), 'first_comparison').status).toBe('todo');
    await h.fixture.prisma.reconSummary.update({ where: { id: summary.id }, data: { listed: 1, computedAt: null } });
    const p = await get(b, b.owner);
    expect(p).toMatchObject({ percent: 25, nextStepId: 'erp_upload' });
    expect(status(p, 'first_comparison').status).toBe('todo');
    expect(p.marketplaces.every(m => !m.applied)).toBe(true);
    const spec = h.api.spec.paths['/api/onboarding'];
    expect(Object.keys(spec)).toEqual(['get']);
    expect(h.api.spec.paths['/api/onboarding/skip']).toBeUndefined();
    expect(h.api.spec.paths['/api/onboarding/dismiss']).toBeUndefined();
    const schema = spec!.get!.responses['200'] as { content: { 'application/json': { schema: { properties: { data: { required: string[] } } } } } };
    expect(schema.content['application/json'].schema.properties.data.required).toEqual(['steps', 'percent', 'nextStepId', 'complete', 'marketplaces']);
  });
});
