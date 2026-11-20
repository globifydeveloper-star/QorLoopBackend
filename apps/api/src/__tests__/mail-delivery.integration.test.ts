// Plan step 15 (ADR 021): code mail first, never after its expiry, short retry lease, failure after ten attempts.
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { AuthService } from '../auth/auth.service.js';
import { deliverDueMail, type MailTransport } from '../../../worker/src/deliver-mail.js';
import { seal } from '../../../../packages/shared/src/security.js';
import { testDatabase } from './database.js';
import { loadConfig } from '../../../../packages/shared/src/config.js';

const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/test', AUTH_SECRET: 'test-only-secret-at-least-thirty-two-characters', MAIL_FROM: 'noreply@mail.example.test' });
let fixture: Awaited<ReturnType<typeof testDatabase>>;
let tenantId: string;
beforeAll(async () => {
  fixture = await testDatabase();
  tenantId = (await new AuthService(fixture.database, config).provision({ name: 'Mail', slug: 'mail-a', hostname: 'mail-a.localhost', ownerEmail: 'owner@mail-a.test' })).tenantId;
});
afterAll(async () => { await fixture.close(); });

const queue = async (key: string, text: string, options: { priority?: number; discardAfter?: Date } = {}) =>
  fixture.database.run(tenantId, async data => data.queueMail(key, await seal({ to: 'user@mail-a.test', subject: 's', text }, config.AUTH_SECRET), options));
function recorder(fail = false) {
  const sent: { to: string; text: string; messageId: string; from: { name: string; address: string } }[] = [];
  const transport: MailTransport = { sendMail: async m => { if (fail) throw new Error('smtp refused: secret detail'); sent.push(m); } };
  return { sent, transport };
}

describe('mail delivery', () => {
  it('sends code mail first, from the configured name, with a Message-ID on the sending domain', async () => {
    const code = await queue('otp:test:1', 'code mail', { priority: 1, discardAfter: new Date(Date.now() + 600_000) });
    const { sent, transport } = recorder();
    const result = await deliverDueMail({ database: fixture.database, transport, config });
    expect(result.sent).toBe(2);
    expect(sent.map(m => m.text)).toEqual(['code mail', expect.stringContaining('Accept your invitation')]);
    expect(sent[0]).toMatchObject({ from: { name: 'Qorloop', address: 'noreply@mail.example.test' }, messageId: `<${code.id}@mail.example.test>` });
    const rows = await fixture.prisma.emailOutbox.findMany({ where: { tenantId } });
    expect(rows.every(r => r.deliveredAt && r.sealedMessage === '')).toBe(true);
  });
  it('never sends a code after it expired: the mail is marked failed and its body cleared', async () => {
    const expired = await queue('otp:test:2', 'stale code', { priority: 1, discardAfter: new Date(Date.now() - 1000) });
    const { sent, transport } = recorder();
    expect(await deliverDueMail({ database: fixture.database, transport, config })).toEqual({ sent: 0, discarded: 1 });
    expect(sent).toEqual([]);
    expect(await fixture.prisma.emailOutbox.findUniqueOrThrow({ where: { id: expired.id } })).toMatchObject({ deliveredAt: null, sealedMessage: '', failedAt: expect.any(Date) });
  });
  it('retries code mail after 20 seconds, other mail after 5 minutes, and gives up after ten attempts without logging details', async () => {
    const codeMail = await queue('otp:test:3', 'retry code', { priority: 1, discardAfter: new Date(Date.now() + 600_000) });
    const normal = await queue('notice:test', 'notice');
    const logged: object[] = [];
    const log = { error: (obj: object) => { logged.push(obj); } };
    const { transport } = recorder(true);
    const before = Date.now();
    await deliverDueMail({ database: fixture.database, transport, config, log });
    const [c, n] = await Promise.all([codeMail.id, normal.id].map(id => fixture.prisma.emailOutbox.findUniqueOrThrow({ where: { id } })));
    expect(c!.attempts).toBe(1);
    expect(c!.availableAt.getTime() - before).toBeGreaterThanOrEqual(19_000);
    expect(c!.availableAt.getTime() - before).toBeLessThan(60_000);
    expect(n!.availableAt.getTime() - before).toBeGreaterThanOrEqual(299_000);
    expect(JSON.stringify(logged)).not.toMatch(/secret detail|user@|retry code/);

    // The tenth failed attempt marks it failed (code mail loses its body) and records a safe event.
    await fixture.prisma.emailOutbox.update({ where: { id: codeMail.id }, data: { attempts: 9, availableAt: new Date(Date.now() - 1000) } });
    await deliverDueMail({ database: fixture.database, transport, config, log });
    expect(await fixture.prisma.emailOutbox.findUniqueOrThrow({ where: { id: codeMail.id } })).toMatchObject({ attempts: 10, sealedMessage: '', failedAt: expect.any(Date) });
    const event = await fixture.prisma.auditEvent.findFirstOrThrow({ where: { tenantId, action: 'mail.undeliverable' } });
    expect(event).toMatchObject({ entityId: codeMail.id, details: { attempts: 10 } });
    expect((await deliverDueMail({ database: fixture.database, transport: recorder().transport, config })).sent).toBe(0);
  });
});
