import { Queue, type ConnectionOptions } from 'bullmq';

export const QUEUES = { uploads: 'upload-processing' } as const;

/** Job payloads carry the tenant ID (shared Redis later) and nothing sensitive. */
export interface ProcessUploadJob {
  tenantId: string;
  uploadId: string;
  /** Bumps when the same upload is re-queued on purpose (e.g. after the user confirms a mapping). */
  revision: number;
}

export interface UploadQueue {
  enqueueProcess(job: ProcessUploadJob): Promise<void>;
}

/** BullMQ's job ID is the idempotency key: enqueueing the same revision twice is a no-op. */
export const processJobId = (j: ProcessUploadJob) => `process-${j.tenantId}-${j.uploadId}-${j.revision}`;

export const JOB_DEFAULTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

export class BullUploadQueue implements UploadQueue {
  private readonly queue: Queue;
  constructor(connection: ConnectionOptions) {
    this.queue = new Queue(QUEUES.uploads, { connection, defaultJobOptions: JOB_DEFAULTS });
  }
  async enqueueProcess(job: ProcessUploadJob) {
    await this.queue.add('process-upload', job, { jobId: processJobId(job) });
  }
  close() { return this.queue.close(); }
}

/** Test double: records jobs and optionally runs a handler inline. */
export class InlineUploadQueue implements UploadQueue {
  readonly jobs: ProcessUploadJob[] = [];
  handler?: (job: ProcessUploadJob) => Promise<void>;
  async enqueueProcess(job: ProcessUploadJob) {
    if (this.jobs.some(j => processJobId(j) === processJobId(job))) return;
    this.jobs.push(job);
    await this.handler?.(job);
  }
}
