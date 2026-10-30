import { Queue, type ConnectionOptions } from 'bullmq';

export const QUEUES = { uploads: 'upload-processing', uploadApply: 'upload-apply' } as const;

/** Job payloads carry the tenant ID (shared Redis later) and nothing sensitive. */
export interface ProcessUploadJob {
  tenantId: string;
  uploadId: string;
  /** Bumps when the same upload is re-queued on purpose (e.g. after the user confirms a mapping). */
  revision: number;
}

/** Writes a reviewed upload to the catalogue. Same shape; the revision is the one set by needs_review -> applying. */
export type ApplyUploadJob = ProcessUploadJob;

export interface UploadQueue {
  enqueueProcess(job: ProcessUploadJob): Promise<void>;
  enqueueApply(job: ApplyUploadJob): Promise<void>;
}

/** BullMQ's job ID is the idempotency key: enqueueing the same revision twice is a no-op. */
export const processJobId = (j: ProcessUploadJob) => `process-${j.tenantId}-${j.uploadId}-${j.revision}`;
export const applyJobId = (j: ApplyUploadJob) => `apply-${j.tenantId}-${j.uploadId}-${j.revision}`;

export const JOB_DEFAULTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

export class BullUploadQueue implements UploadQueue {
  private readonly queue: Queue;
  private readonly applyQueue: Queue;
  constructor(connection: ConnectionOptions) {
    this.queue = new Queue(QUEUES.uploads, { connection, defaultJobOptions: JOB_DEFAULTS });
    this.applyQueue = new Queue(QUEUES.uploadApply, { connection, defaultJobOptions: JOB_DEFAULTS });
  }
  async enqueueProcess(job: ProcessUploadJob) {
    await this.queue.add('process-upload', job, { jobId: processJobId(job) });
  }
  async enqueueApply(job: ApplyUploadJob) {
    await this.applyQueue.add('apply-upload', job, { jobId: applyJobId(job) });
  }
  async close() { await this.queue.close(); await this.applyQueue.close(); }
}

/** Test double: records jobs and optionally runs a handler inline. */
export class InlineUploadQueue implements UploadQueue {
  readonly jobs: ProcessUploadJob[] = [];
  readonly applyJobs: ApplyUploadJob[] = [];
  handler?: (job: ProcessUploadJob) => Promise<void>;
  applyHandler?: (job: ApplyUploadJob) => Promise<void>;
  async enqueueProcess(job: ProcessUploadJob) {
    if (this.jobs.some(j => processJobId(j) === processJobId(job))) return;
    this.jobs.push(job);
    await this.handler?.(job);
  }
  async enqueueApply(job: ApplyUploadJob) {
    if (this.applyJobs.some(j => applyJobId(j) === applyJobId(job))) return;
    this.applyJobs.push(job);
    await this.applyHandler?.(job);
  }
}
