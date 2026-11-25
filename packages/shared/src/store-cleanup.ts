import { Queue, type ConnectionOptions } from 'bullmq';
import { JOB_DEFAULTS } from './queue.js';

/**
 * After an in-app store reset (ADR 022): delete the store's uploaded and generated files that no row points at any
 * more. Delayed, so a file generation that was already running when the reset committed has finished writing.
 */
export const STORE_CLEANUP_QUEUE = 'store-cleanup';
export const STORE_CLEANUP_DELAY_MS = 2 * 60_000;
export interface StoreCleanupJob { tenantId: string; resetEventId: string; resetAt: string }

export interface StoreCleanupQueue {
  enqueue(job: StoreCleanupJob): Promise<void>;
}

export class BullStoreCleanupQueue implements StoreCleanupQueue {
  private readonly queue: Queue<StoreCleanupJob>;
  constructor(connection: ConnectionOptions) {
    this.queue = new Queue(STORE_CLEANUP_QUEUE, { connection, defaultJobOptions: JOB_DEFAULTS });
  }
  async enqueue(job: StoreCleanupJob) {
    // One job per reset: a retried request cannot queue it twice.
    await this.queue.add('clean-store-storage', job, { jobId: `cleanup-${job.resetEventId}`, delay: STORE_CLEANUP_DELAY_MS });
  }
  close() { return this.queue.close(); }
}

/** Test double: records the jobs; `handler` (when set) runs each one at once. */
export class InlineStoreCleanupQueue implements StoreCleanupQueue {
  readonly jobs: StoreCleanupJob[] = [];
  handler?: (job: StoreCleanupJob) => Promise<unknown>;
  async enqueue(job: StoreCleanupJob) {
    this.jobs.push(job);
    await this.handler?.(job);
  }
}
