import { Worker, Queue } from 'bullmq';
import { Redis } from 'ioredis';
import nodemailer from 'nodemailer';
import pino from 'pino';
import { Database } from '../../../packages/db/src/database.js';
import { loadConfig } from '../../../packages/shared/src/config.js';
import { unseal } from '../../../packages/shared/src/security.js';

const config = loadConfig();
const log = pino();
const database = new Database(config.DATABASE_URL);
await database.connect();
const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const transport = nodemailer.createTransport({
  host: config.SMTP_HOST, port: config.SMTP_PORT, secure: config.SMTP_PORT === 465,
  requireTLS: config.NODE_ENV === 'production' && config.SMTP_PORT !== 465,
  ...(config.SMTP_USER ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } } : {}),
});
const queue = new Queue('email-outbox', { connection });
await queue.upsertJobScheduler('outbox-poll', { every: 10_000 }, { name: 'deliver', data: {}, opts: { removeOnComplete: 10, removeOnFail: 10 } });
const worker = new Worker('email-outbox', async () => {
  for (const row of await database.dueMail()) {
    const mail = await database.run(row.tenantId, data => data.claimMail(row.id));
    if (!mail) continue;
    try {
      const message = await unseal<{to: string; subject: string; text: string}>(mail.sealedMessage, config.AUTH_SECRET);
      await transport.sendMail({ ...message, from: config.MAIL_FROM, messageId: '<' + row.id + '@qorloop.globify.ae>' });
      await database.run(row.tenantId, data => data.ackMail(row.id));
    } catch {
      // Lease expires in five minutes. Maximum ten delivery attempts; retain the
      // encrypted payload for operations inspection, never print it.
      log.error({ outboxId: row.id }, 'Email delivery failed; retry scheduled');
    }
  }
}, { connection, concurrency: 1 });
worker.on('error', () => log.error('Email worker failed'));
connection.on('error', () => log.error('Redis connection failed'));
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await worker.close(); await queue.close(); await connection.quit(); transport.close(); await database.close();
}
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
log.info('Email worker ready; inventory processing is a later milestone');

