import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { z } from 'zod';
import { Database } from '../../../../packages/db/src/database.js';
import { GenerationBlocked, selectedForFile } from '../../../../packages/core/src/generated-files.js';
import type { MarketplaceId } from '../../../../packages/core/src/constants.js';
import { MARKETPLACE_LABELS } from '../../../../packages/core/src/price-change.js';
import { STALE_EXPORT_MESSAGE, exportToken, loadGenerationInputs, prepareGeneration, type GeneratedFilesQueue } from '../../../../packages/shared/src/generated-files.js';
import type * as contracts from '../../../../packages/shared/src/contracts.js';
import type { ObjectStorage } from '../../../../packages/shared/src/storage.js';
import { AuthService, type RequestContext } from '../auth/auth.service.js';
import { enabledMarketplaceIds } from '../pricing/pricing.data.js';
import { GENERATED_FILES_QUEUE, STORAGE } from '../tokens.js';

type Input = z.infer<typeof contracts.generateMarketplaceFile>;
@Injectable()
export class GeneratedFilesService {
  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(STORAGE) private readonly storage: ObjectStorage,
    @Inject(GENERATED_FILES_QUEUE) private readonly queue: GeneratedFilesQueue,
  ) {}

  private async prepare(ctx: RequestContext, input: Input, permission: 'files.preview' | 'files.generate') {
    const actorId = await this.auth.authenticated(ctx, { permission, mutation: true }, async (_d, p) => p.user.id);
    try {
      const inputs = await this.database.readSnapshot(ctx.tenantId, d => loadGenerationInputs(d, input.marketplaceId, input.reference));
      const { exportToken: _ignored, ...rest } = input;
      const params = { ...rest, reference: inputs.referenceUsed };
      const prepared = await prepareGeneration(this.storage, inputs, params);
      return { actorId, inputs, params, token: exportToken(inputs, params), ...prepared };
    } catch (e) {
      if (e instanceof GenerationBlocked) throw new ConflictException(e.message);
      throw e;
    }
  }

  async preview(ctx: RequestContext, input: Input) {
    const { inputs, params, plan, warnings, token } = await this.prepare(ctx, input, 'files.preview');
    const { productCount, rowsToWrite, priceChanges, availabilityChanges, notInFile, largestPriceChange, firstRows } = plan;
    const ageDays = Math.floor((Date.now() - inputs.upload.createdAt.getTime()) / 86_400_000);
    const selected = inputs.rows.filter(r => selectedForFile(r, params));
    return {
      productCount, rowsToWrite, priceChanges, availabilityChanges, notInFile, largestPriceChange, firstRows,
      sourceFile: { name: inputs.upload.fileName, uploadedAt: inputs.upload.createdAt },
      warnings: [...(ageDays >= 1 ? [`The marketplace file is ${ageDays} ${ageDays === 1 ? 'day' : 'days'} old`] : []), ...warnings],
      referenceUsed: inputs.referenceUsed,
      // migration 202611100001: export values in effect win in every file; the token guards generation against drift
      valueBasis: 'export_values' as const, exportToken: token,
      exportValueProducts: plan.exportValueProducts ?? 0,
      blockedExportProducts: inputs.rows.filter(r => r.blockedExport).length,
      fromOlderFile: selected.filter(r => r.listingUploadId && r.listingUploadId !== inputs.upload.id).length,
    };
  }
  async generate(ctx: RequestContext, input: Input) {
    // Return all blocking reasons synchronously; the worker repeats validation against its own fresh snapshot.
    const { actorId, params, token } = await this.prepare(ctx, input, 'files.generate');
    if (input.exportToken && input.exportToken !== token) throw new ConflictException(STALE_EXPORT_MESSAGE);
    const jobId = await this.queue.enqueue({ ...params, tenantId: ctx.tenantId, actorId, requestId: ctx.requestId, requestedAt: new Date().toISOString(), exportToken: token });
    return { jobId };
  }
  /**
   * The updated files of several marketplaces in one request (default: every enabled marketplace). Each is checked
   * and queued exactly as POST /api/generated-files; one that cannot be generated is reported with its plain reason
   * and does not stop the others. Poll each jobId with GET /api/generated-files/jobs/:jobId.
   */
  async generateMany(ctx: RequestContext, input: z.infer<typeof contracts.generateMarketplaceFiles>) {
    const enabled = await this.auth.authenticated(ctx, { permission: 'files.generate', mutation: true }, async d => enabledMarketplaceIds(d));
    const jobs: { marketplaceId: MarketplaceId; jobId: string }[] = [];
    const blocked: { marketplaceId: MarketplaceId; message: string }[] = [];
    for (const marketplaceId of input.marketplaceIds ?? enabled) {
      if (!enabled.includes(marketplaceId)) { blocked.push({ marketplaceId, message: `${MARKETPLACE_LABELS[marketplaceId]} is not enabled for this store` }); continue; }
      try {
        const { jobId } = await this.generate(ctx, { marketplaceId, kind: input.kind, scope: input.scope, reference: input.reference, exportToken: input.exportTokens?.[marketplaceId] });
        jobs.push({ marketplaceId, jobId });
      } catch (e) {
        if (!(e instanceof ConflictException)) throw e;
        blocked.push({ marketplaceId, message: e.message });
      }
    }
    return { jobs, blocked };
  }
  async job(ctx: RequestContext, jobId: string) {
    await this.auth.authenticated(ctx, { permission: 'files.view' }, async () => undefined);
    const result = await this.queue.status(jobId, ctx.tenantId);
    if (!result) throw new NotFoundException('Generation job not found');
    return result;
  }
  history(ctx: RequestContext) {
    return this.auth.authenticated(ctx, { permission: 'files.view' }, async d => {
      const rows = await d.generatedFiles.history(new Date());
      return rows.map(row => ({ ...row, generatedBy: row.generatedBy.name }));
    });
  }
  async download(ctx: RequestContext, id: string) {
    const file = await this.auth.authenticated(ctx, { permission: 'files.download' }, async d => d.generatedFiles.get(id));
    if (!file || file.expiresAt.getTime() <= Date.now() || !await this.storage.head(file.storageKey)) throw new NotFoundException('Generated file not found');
    const now = Date.now();
    const ttlSeconds = Math.min(300, Math.floor((file.expiresAt.getTime() - now) / 1000));
    if (ttlSeconds < 1) throw new NotFoundException('Generated file not found');
    const url = await this.storage.presignDownload(file.storageKey, { fileName: file.fileName, ttlSeconds });
    return { url, fileName: file.fileName, expiresAt: new Date(now + ttlSeconds * 1000) };
  }
}
