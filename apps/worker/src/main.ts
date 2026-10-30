import { Worker, Queue } from 'bullmq';
import { Redis } from 'ioredis';
import nodemailer from 'nodemailer';
import pino from 'pino';
import { Database } from '../../../packages/db/src/database.js';
import { loadConfig } from '../../../packages/shared/src/config.js';
import { unseal } from '../../../packages/shared/src/security.js';
import { S3Storage } from '../../../packages/shared/src/storage.js';
import { applyJobId, JOB_DEFAULTS, processJobId, QUEUES, type ApplyUploadJob, type ProcessUploadJob } from '../../../packages/shared/src/queue.js';
import { markFailed, processUpload, recoverStuckUploads } from './process-upload.js';
import { applyUpload, revertToReview } from './apply-upload.js';

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

// Upload processing: parse, detect layout, validate and build the review for 25 MB / 50,000-row files.
const storage = new S3Storage({
  bucket: config.S3_BUCKET, region: config.S3_REGION, endpoint: config.S3_ENDPOINT, forcePathStyle: config.S3_FORCE_PATH_STYLE,
  accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY,
});
const deps = { database, storage, log };
const uploadQueue = new Queue(QUEUES.uploads, { connection, defaultJobOptions: JOB_DEFAULTS });
const uploadWorker = new Worker<ProcessUploadJob>(QUEUES.uploads, job => processUpload(deps, job.data), { connection, concurrency: config.UPLOAD_CONCURRENCY, lockDuration: 120_000 });
uploadWorker.on('failed', (job, err) => {
  log.error({ jobId: job?.id, errorType: err.name }, 'Upload processing attempt failed');
  if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) void markFailed(deps, job.data).catch(() => log.error('Could not mark upload failed'));
});
uploadWorker.on('error', () => log.error('Upload worker failed'));

// Apply: one short transaction per upload; a failed apply returns the upload to needs_review itself.
const applyQueue = new Queue(QUEUES.uploadApply, { connection, defaultJobOptions: JOB_DEFAULTS });
const applyWorker = new Worker<ApplyUploadJob>(QUEUES.uploadApply, job => applyUpload(deps, job.data), { connection, concurrency: config.UPLOAD_CONCURRENCY, lockDuration: 120_000 });
applyWorker.on('failed', (job, err) => {
  log.error({ jobId: job?.id, errorType: err.name }, 'Upload apply attempt failed');
  if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) void revertToReview(deps, job.data).catch(() => log.error('Could not return upload to review'));
});
applyWorker.on('error', () => log.error('Upload apply worker failed'));

const sweep = setInterval(() => {
  recoverStuckUploads(deps, async (j, kind) => {
    if (kind === 'apply') await applyQueue.add('apply-upload', j, { jobId: applyJobId(j) });
    else await uploadQueue.add('process-upload', j, { jobId: processJobId(j) });
  })
    .then(n => n && log.info({ requeued: n }, 'Re-queued stuck uploads'))
    .catch(() => log.error('Upload recovery sweep failed'));
}, 5 * 60_000);
connection.on('error', () => log.error('Redis connection failed'));
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(sweep);
  await worker.close(); await uploadWorker.close(); await applyWorker.close(); await uploadQueue.close(); await applyQueue.close(); await queue.close(); await connection.quit(); transport.close(); await database.close();
}
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
log.info('Email and upload workers ready');

