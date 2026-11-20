// Plan steps 2-3 (docs/plans/onboarding-redesign-backend.md): the operations CLI's provisioning with preselected
// marketplaces, and resending the Owner invitation of a store that has no active Owner (B2).
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { AuthService } from '../auth/auth.service.js';
import { unseal } from '../../../../packages/shared/src/security.js';
import { createHarness, password, type Harness } from './harness.js';

let h: Harness;
let auth: AuthService;
beforeAll(async () => {
  h = await createHarness();
  auth = new AuthService(h.fixture.database, h.config);
});
afterAll(async () => { await h.close(); });

/** Every invitation token queued for one invitation, oldest first (the sealed outbox, as the email worker reads it). */
async function tokensFor(invitationId: string) {
  const rows = await h.fixture.prisma.emailOutbox.findMany({ where: { dedupeKey: { startsWith: 'invitation:' + invitationId } }, orderBy: { createdAt: 'asc' } });
  return Promise.all(rows.map(async r => (await unseal<{ text: string }>(r.sealedMessage, h.config.AUTH_SECRET)).text.match(/#token=([A-Za-z0-9_-]+)/)![1]!));
}
const provision = (slug: string, marketplaces?: ('talabat' | 'snoonu' | 'rafeeq' | 'keeta')[]) =>
  auth.provision({ name: slug, slug, hostname: slug + '.localhost', ownerEmail: 'owner@' + slug + '.test', ...(marketplaces ? { marketplaces } : {}) });
const accept = (slug: string, token: string) =>
  h.request('POST', '/api/auth/invitations/accept', { hostname: slug + '.localhost' }, undefined, { token, name: 'Owner', password });

describe('provisioning with marketplaces', () => {
  it('writes an explicit switch for all four marketplaces, once', async () => {
    const result = await provision('prov-mp', ['talabat']);
    expect(result).toMatchObject({ created: true, marketplaces: 'set' });
    const rows = await h.fixture.prisma.tenantMarketplace.findMany({ where: { tenantId: result.tenantId }, orderBy: { marketplaceId: 'asc' } });
    expect(rows.map(r => [r.marketplaceId, r.enabled])).toEqual([['keeta', false], ['rafeeq', false], ['snoonu', false], ['talabat', true]]);
    const event = await h.fixture.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: result.tenantId, action: 'settings.changed' } });
    expect(event.details).toEqual({ field: 'marketplaces', old: [], new: ['talabat'] });

    // A rerun is idempotent: same invitation, no new mail, switches left as they are.
    const again = await provision('prov-mp', ['snoonu']);
    expect(again).toMatchObject({ tenantId: result.tenantId, invitationId: result.invitationId, created: false, marketplaces: 'unchanged' });
    expect((await h.fixture.prisma.tenantMarketplace.findFirstOrThrow({ where: { tenantId: result.tenantId, marketplaceId: 'talabat' } })).enabled).toBe(true);
    expect(await h.fixture.prisma.emailOutbox.count({ where: { tenantId: result.tenantId } })).toBe(1);
  });
  it('leaves marketplaces unset without the option (implicit enabling for legacy stores stays)', async () => {
    const result = await provision('prov-none');
    expect(result.marketplaces).toBe('not_given');
    expect(await h.fixture.prisma.tenantMarketplace.count({ where: { tenantId: result.tenantId } })).toBe(0);
  });
});

describe('resend the Owner invitation (operations)', () => {
  it('rotates an expired invitation: the new link works, the old one does not', async () => {
    const { tenantId, invitationId } = await provision('prov-expired');
    const [oldToken] = await tokensFor(invitationId);
    await h.fixture.prisma.invitation.update({ where: { id: invitationId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await accept('prov-expired', oldToken!)).statusCode).toBe(400);

    const resent = await auth.resendOwnerInvitation(tenantId);
    expect(resent).toMatchObject({ invitationId, created: false });
    expect(resent.expiresAt.getTime()).toBeGreaterThan(Date.now() + 47 * 3_600_000);
    expect(JSON.stringify(resent)).not.toMatch(/token/i);
    const tokens = await tokensFor(invitationId);
    expect(tokens).toHaveLength(2);
    expect(tokens[1]).not.toBe(oldToken);
    const event = await h.fixture.prisma.auditEvent.findFirstOrThrow({ where: { tenantId, action: 'invitation.resent' } });
    expect(event).toMatchObject({ actorId: null, entityId: invitationId, requestId: 'operations' });

    expect((await accept('prov-expired', oldToken!)).statusCode).toBe(400);
    const accepted = await accept('prov-expired', tokens[1]!);
    expect(accepted.statusCode).toBe(200);
  });
  it('is refused once the store has an active Owner', async () => {
    await expect(auth.resendOwnerInvitation((await h.fixture.prisma.tenant.findUniqueOrThrow({ where: { slug: 'prov-expired' } })).id))
      .rejects.toThrow('already has an active Owner');
  });
  it('creates a new invitation to the initial Owner email when every Owner invitation was revoked', async () => {
    const { tenantId, invitationId } = await provision('prov-revoked');
    await h.fixture.prisma.invitation.update({ where: { id: invitationId }, data: { revokedAt: new Date(), pendingEmail: null } });
    const resent = await auth.resendOwnerInvitation(tenantId);
    expect(resent.created).toBe(true);
    expect(resent.invitationId).not.toBe(invitationId);
    const invitation = await h.fixture.prisma.invitation.findUniqueOrThrow({ where: { id: resent.invitationId } });
    expect(invitation).toMatchObject({ email: 'owner@prov-revoked.test', role: 'owner', invitedBy: null });
    expect((await accept('prov-revoked', (await tokensFor(resent.invitationId))[0]!)).statusCode).toBe(200);
  });
  it('finds stores by slug for the CLI, routing fields only', async () => {
    const tenant = await h.fixture.database.tenantBySlug('prov-revoked');
    expect(Object.keys(tenant!).sort()).toEqual(['hostname', 'id', 'name', 'slug', 'status']);
    expect(await h.fixture.database.tenantBySlug('no-such-store')).toBeNull();
  });
});

describe('owner recovery by support (recover-owner, ADR 021)', () => {
  it('moves an Owner to a new address, signs them out everywhere and mails a password link there', async () => {
    const s = await h.createOwner('prov-recover');
    const owner = await h.fixture.prisma.user.findFirstOrThrow({ where: { tenantId: s.id } });
    await h.fixture.prisma.user.update({ where: { id: owner.id }, data: { mfaSecret: 'sealed-app-secret' } });
    await expect(auth.recoverOwner(s.id, 'nobody@prov-recover.test', 'new@prov-recover.test')).rejects.toThrow('No active Owner');
    const result = await auth.recoverOwner(s.id, owner.email, 'new@prov-recover.test');
    expect(result).toEqual({ userId: owner.id, signedOut: 1 });
    expect(JSON.stringify(result)).not.toMatch(/token|http/i);
    expect((await h.request('GET', '/api/auth/me', s, s.owner)).statusCode).toBe(401);
    expect(await h.fixture.prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).toMatchObject({ email: 'new@prov-recover.test', mfaSecret: null });
    const mails = await h.fixture.prisma.emailOutbox.findMany({ where: { tenantId: s.id, OR: [{ dedupeKey: { startsWith: 'reset:' } }, { dedupeKey: { startsWith: 'recover-notice:' } }] } });
    const plain = await Promise.all(mails.map(m => unseal<{ to: string; text: string }>(m.sealedMessage, h.config.AUTH_SECRET)));
    expect(plain.map(m => m.to).sort()).toEqual([owner.email, 'new@prov-recover.test'].sort());
    const link = plain.find(m => m.to === 'new@prov-recover.test')!.text.match(/#token=([A-Za-z0-9_-]+)/)![1]!;
    expect((await h.request('POST', '/api/auth/password/reset', s, undefined, { token: link, password: 'A brand new owner password!' })).statusCode).toBe(200);
    expect((await h.request('POST', '/api/auth/login', s, undefined, { email: 'new@prov-recover.test', password: 'A brand new owner password!' })).json().data.state).toBe('otp_required');
    expect(await h.fixture.prisma.auditEvent.count({ where: { tenantId: s.id, action: 'support.owner_email_changed', requestId: 'operations' } })).toBe(1);
  });
});
