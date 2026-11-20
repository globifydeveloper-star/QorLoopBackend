import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

/** The worker's outbox queue: a poll every 10 s, plus a nudge right after a code mail is queued (owner decision D15). */
export const MAIL_QUEUE_NAME = 'email-outbox';

/** Asks the worker to deliver due mail now. Best effort: the 10-second poll still delivers if a nudge is lost. */
export interface MailTrigger { nudge(): Promise<void> }

export class BullMailTrigger implements MailTrigger {
  private readonly queue: Queue;
  constructor(connection: Redis) { this.queue = new Queue(MAIL_QUEUE_NAME, { connection }); }
  async nudge() {
    // One waiting nudge at a time (same job id); removed on completion, so the next nudge can be added.
    await this.queue.add('deliver', {}, { jobId: 'nudge', removeOnComplete: true, removeOnFail: true }).catch(() => undefined);
  }
  close() { return this.queue.close(); }
}

/** Tests and CLI scripts: counts nudges, delivers nothing. */
export class InlineMailTrigger implements MailTrigger {
  nudges = 0;
  async nudge() { this.nudges++; }
}
