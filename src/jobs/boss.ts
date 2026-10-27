import PgBoss from 'pg-boss';
import { env } from '../config/env.js';

export const QUEUES = {
  PROCESS_UPLOAD: 'process-upload',
  APPLY_UPLOAD: 'apply-upload',
  RECON_REFRESH: 'recon-refresh',
  GENERATE_FILE: 'generate-file'
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

let boss: PgBoss | null = null;

export async function initBoss(): Promise<PgBoss | null> {
  try {
    boss = new PgBoss({
      connectionString: env.DATABASE_URL,
      archiveCompletedAfterSeconds: 60 * 60 * 24 // 1 day
    });

    boss.on('error', (error) => {
      console.error('[pg-boss] error:', error);
    });

    await boss.start();
    console.log('[pg-boss] Background worker engine initialized');
    return boss;
  } catch (err) {
    console.warn('[pg-boss] Database not connected yet, skipping worker startup:', (err as Error).message);
    return null;
  }
}

export function getBoss(): PgBoss | null {
  return boss;
}
