import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { Database } from '../../../../packages/db/src/database.js';
import { ResetRefused, resetSummary } from '../../../../packages/db/src/store-reset.js';
import type * as contracts from '../../../../packages/shared/src/contracts.js';
import type { StoreCleanupQueue } from '../../../../packages/shared/src/store-cleanup.js';
import { AuthService, type RequestContext } from '../auth/auth.service.js';
import { STORE_CLEANUP_QUEUE } from '../tokens.js';

/** A large store's reset (tens of thousands of products and comparison rows) must still be one transaction. */
const RESET_TIMEOUT_MS = 10 * 60_000;

/**
 * ADR 022: the Owner resets the store's business data from Settings. The same plan and SQL as the operations script
 * (ADR 018), in the request's own transaction: the tenant row lock, a fresh single-use code, and the store's slug typed
 * to confirm. Anything refused rolls back, the code included, so the Owner can try again with the same code.
 */
@Injectable()
export class StoreResetService {
  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(STORE_CLEANUP_QUEUE) private readonly cleanup: StoreCleanupQueue,
  ) {}

  preview(ctx: RequestContext) {
    return this.auth.authenticated(ctx, { permission: 'store.reset' }, async d => {
      const tenant = await d.tenant();
      const { tables, inFlightUploads } = await d.resetPreview();
      return {
        store: { name: tenant.name, slug: tenant.slug },
        deletes: resetSummary(tables),
        inFlightUploads,
        blockedReason: inFlightUploads > 0 ? 'An upload is still being processed. Wait until it finishes before resetting.' : null,
      };
    });
  }

  async reset(ctx: RequestContext, input: z.infer<typeof contracts.resetStoreData>) {
    let result: { eventId: string; deleted: Record<string, number> };
    try {
      result = await this.auth.authenticated(ctx, { permission: 'store.reset', mutation: true, stepUp: 'single', timeout: RESET_TIMEOUT_MS }, async (d, p) => {
        const tenant = await d.tenant();
        if (input.confirmSlug.toLowerCase() !== tenant.slug) {
          const message = `Type ${tenant.slug} exactly to confirm`;
          throw new BadRequestException({ message, details: [{ path: 'confirmSlug', message }] });
        }
        return d.resetStoreData({ actorId: p.user.id, requestId: ctx.requestId });
      });
    } catch (e) {
      if (e instanceof ResetRefused) throw new ConflictException(e.message);
      throw e;
    }
    const resetAt = new Date().toISOString();
    // Best effort after COMMIT: the reset itself is done and recorded whatever happens here.
    await this.database.analyzeAfterReset().catch(() => undefined);
    let storageCleanup: 'queued' | 'not_queued' = 'queued';
    try { await this.cleanup.enqueue({ tenantId: ctx.tenantId, resetEventId: result.eventId, resetAt }); } catch { storageCleanup = 'not_queued'; }
    return { eventId: result.eventId, deleted: resetSummary(result.deleted), storageCleanup };
  }
}
