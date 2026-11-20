import type { Database } from '../../../packages/db/src/database.js';
import type { Config } from '../../../packages/shared/src/config.js';
import { unseal } from '../../../packages/shared/src/security.js';

export interface MailTransport { sendMail(message: { from: { name: string; address: string }; to: string; subject: string; text: string; messageId: string }): Promise<unknown> }
export interface MailDeps {
  database: Database;
  transport: MailTransport;
  config: Pick<Config, 'AUTH_SECRET' | 'MAIL_FROM' | 'MAIL_FROM_NAME'>;
  log?: { error: (obj: object, msg: string) => void; info?: (obj: object, msg: string) => void };
}

/**
 * One delivery round: give up expired code mail, then send due mail, codes first. Each message is claimed under a
 * lease (20 s for codes, 5 minutes otherwise) so a crash or a failed send retries later. After the tenth failed attempt
 * the mail is marked failed; code mail also loses its body. Payloads, addresses and codes are never logged.
 */
export async function deliverDueMail(deps: MailDeps) {
  const { database, transport, config, log } = deps;
  const discarded = await database.discardExpiredMail();
  if (discarded) log?.info?.({ discarded }, 'Expired code mail discarded');
  const domain = config.MAIL_FROM.split('@')[1] ?? 'localhost';
  let sent = 0;
  for (const row of await database.dueMail()) {
    const mail = await database.run(row.tenantId, data => data.claimMail(row.id));
    if (!mail) continue;
    try {
      const message = await unseal<{ to: string; subject: string; text: string }>(mail.sealedMessage, config.AUTH_SECRET);
      await transport.sendMail({ ...message, from: { name: config.MAIL_FROM_NAME, address: config.MAIL_FROM }, messageId: '<' + row.id + '@' + domain + '>' });
      await database.run(row.tenantId, data => data.ackMail(row.id));
      sent++;
    } catch {
      log?.error({ outboxId: row.id, attempt: mail.attempts + 1 }, 'Email delivery failed; retry scheduled');
      if (mail.attempts + 1 >= 10) {
        await database.run(row.tenantId, async data => {
          await data.failMail(row.id, mail.priority > 0);
          await data.event('mail.undeliverable', null, row.id, undefined, { attempts: mail.attempts + 1 });
        });
      }
    }
  }
  return { sent, discarded };
}
