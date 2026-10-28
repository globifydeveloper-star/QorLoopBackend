import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { AuthService, type RequestContext } from '../auth/auth.service.js';
import type { Config } from '../../../../packages/shared/src/config.js';
import type * as contracts from '../../../../packages/shared/src/contracts.js';
import { storageKeys, type ObjectStorage } from '../../../../packages/shared/src/storage.js';
import type { UploadQueue } from '../../../../packages/shared/src/queue.js';
import { extensionOf, isAllowedExtension } from '../../../../packages/core/src/upload/safety.js';
import { signatureFor, validateMapping } from '../../../../packages/core/src/upload/mapping.js';
import { fieldsFor } from '../../../../packages/core/src/upload/fields.js';
import { RETENTION_DAYS, UPLOAD_LIMITS } from '../../../../packages/core/src/upload/constants.js';
import { CONFIG, STORAGE, UPLOAD_QUEUE } from '../tokens.js';

const CONTENT_TYPES: Record<string, string> = {
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.csv': 'text/csv',
};

const TABS: Record<string, string[] | undefined> = {
  price: ['price', 'price_stock', 'price_availability'],
  stock: ['stock', 'price_stock'],
  availability: ['availability', 'price_availability'],
  new: ['new'],
  unmatched: ['unmatched'],
  all: undefined,
};

type UploadRow = {
  id: string; source: string; fileName: string; size: number; contains: string; status: string; step: string | null;
  progress: number; summary: unknown; errorMessage: string | null; uploadedById: string; createdAt: Date; updatedAt: Date;
  appliedAt: Date | null; headers?: unknown; mappingSuggestion?: unknown;
};

/** Never expose storage keys, checksums or internal revision numbers. */
function view(u: UploadRow) {
  return {
    id: u.id, source: u.source, fileName: u.fileName, size: u.size, contains: u.contains, status: u.status,
    step: u.step, progress: u.progress, summary: u.summary ?? null, errorMessage: u.errorMessage,
    uploadedById: u.uploadedById, createdAt: u.createdAt, updatedAt: u.updatedAt, appliedAt: u.appliedAt,
    ...(u.status === 'needs_mapping' ? { headers: u.headers ?? [], mappingSuggestion: u.mappingSuggestion ?? null, fields: fieldsFor(u.source).map(f => ({ key: f.key, label: f.label, required: f.required })) } : {}),
  };
}

@Injectable()
export class UploadsService {
  private readonly log = new Logger('Uploads');
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(STORAGE) private readonly storage: ObjectStorage,
    @Inject(UPLOAD_QUEUE) private readonly queue: UploadQueue,
  ) {}

  /** Steps 1-2: create the upload record and issue a signed URL for a direct, size-bound upload. */
  create(ctx: RequestContext, input: z.infer<typeof contracts.createUpload>) {
    if (!isAllowedExtension(input.fileName)) throw new BadRequestException('Only .xlsx, .xls and .csv files are accepted');
    if (input.size > UPLOAD_LIMITS.maxBytes) throw new BadRequestException('The file is larger than 25 MB');
    const ext = extensionOf(input.fileName);
    return this.auth.authenticated(ctx, { permission: 'uploads.upload', mutation: true }, async (data, p) => {
      const id = randomUUID();
      const contentType = CONTENT_TYPES[ext]!;
      const storageKey = storageKeys.upload(data.tenantId, id, ext);
      const upload = await data.uploads.create({
        id, source: input.source, fileName: input.fileName, contentType, size: input.size, storageKey, contains: input.contains,
        uploadedById: p.user.id, status: 'uploading', expiresAt: new Date(Date.now() + RETENTION_DAYS.uploads * 86_400_000),
      });
      await data.event('upload.created', p.user.id, id, ctx.requestId, { source: input.source, size: input.size });
      const signed = await this.storage.presignUpload(storageKey, { contentType, size: input.size, ttlSeconds: this.config.UPLOAD_URL_TTL_SECONDS });
      return { ...view(upload), uploadUrl: signed.url, uploadMethod: signed.method, uploadHeaders: signed.headers, uploadUrlExpiresAt: signed.expiresAt };
    });
  }

  /** Steps 4-5: confirm the object exists with the declared size, then enqueue processing exactly once. */
  async complete(ctx: RequestContext, id: string) {
    const first = await this.auth.authenticated(ctx, { permission: 'uploads.upload', mutation: true }, async (data, p) => {
      const u = await data.uploads.get(id);
      if (!u) throw new NotFoundException('Upload not found');
      if (u.uploadedById !== p.user.id) throw new ForbiddenException('Only the person who started an upload can complete it');
      return u;
    });
    if (first.status !== 'uploading') return view(first); // idempotent: never enqueue twice

    const head = await this.storage.head(first.storageKey);
    if (!head) throw new ConflictException('The file has not been uploaded yet');
    if (head.size !== first.size || head.size > UPLOAD_LIMITS.maxBytes) {
      await this.auth.authenticated(ctx, { permission: 'uploads.upload', mutation: true }, async (data, p) => {
        await data.uploads.transition(id, ['uploading'], { status: 'rejected', errorMessage: 'The uploaded file size does not match what was declared' });
        await data.event('upload.rejected', p.user.id, id, ctx.requestId, { reason: 'size_mismatch' });
      });
      await this.storage.delete(first.storageKey).catch(() => undefined);
      throw new BadRequestException('The uploaded file size does not match what was declared');
    }

    const { upload, queued } = await this.auth.authenticated(ctx, { permission: 'uploads.upload', mutation: true }, async (data, p) => {
      const ok = await data.uploads.transition(id, ['uploading'], { status: 'processing', step: 'scan', progress: 0, revision: { increment: 1 } });
      const current = (await data.uploads.get(id))!;
      if (ok) await data.event('upload.queued', p.user.id, id, ctx.requestId);
      return { upload: current, queued: ok };
    });
    if (queued) await this.enqueue(ctx.tenantId, upload.id, upload.revision);
    return view(upload);
  }

  list(ctx: RequestContext) {
    return this.auth.authenticated(ctx, { permission: 'uploads.view' }, async data => (await data.uploads.list()).map(view));
  }

  get(ctx: RequestContext, id: string) {
    return this.auth.authenticated(ctx, { permission: 'uploads.view' }, async data => {
      const u = await data.uploads.get(id);
      if (!u) throw new NotFoundException('Upload not found');
      return view(u);
    });
  }

  /** Step 11: the proposed change, by tab, paginated. */
  review(ctx: RequestContext, id: string, query: z.infer<typeof contracts.reviewQuery>) {
    return this.auth.authenticated(ctx, { permission: 'uploads.view' }, async data => {
      const u = await data.uploads.get(id);
      if (!u) throw new NotFoundException('Upload not found');
      if (u.status !== 'needs_review') throw new ConflictException('This upload has no review to show');
      const [rows, total] = await data.uploads.rows(id, TABS[query.tab], (query.page - 1) * query.pageSize, query.pageSize);
      const [, errorCount] = await data.uploads.errors(id, 0, 1);
      return { upload: view(u), tab: query.tab, page: query.page, pageSize: query.pageSize, total, errorCount, rows };
    });
  }

  errors(ctx: RequestContext, id: string, page: number) {
    return this.auth.authenticated(ctx, { permission: 'uploads.view' }, async data => {
      if (!(await data.uploads.get(id))) throw new NotFoundException('Upload not found');
      const [errors, total] = await data.uploads.errors(id, (page - 1) * 200, 200);
      return { page, total, errors };
    });
  }

  /** Step 9 → 10: the user confirms (and optionally saves) a column mapping; processing resumes. */
  async mapping(ctx: RequestContext, id: string, input: z.infer<typeof contracts.confirmMapping>) {
    const { upload, queued } = await this.auth.authenticated(ctx, { permission: 'uploads.map', mutation: true }, async (data, p) => {
      const u = await data.uploads.get(id);
      if (!u) throw new NotFoundException('Upload not found');
      if (u.status !== 'needs_mapping') throw new ConflictException('This upload does not need a mapping');
      const headers = (u.headers as string[] | null) ?? [];
      const problems = validateMapping(u.source, input.fields, headers);
      if (problems.length) throw new BadRequestException({ message: 'Mapping is not valid', details: problems.map(message => ({ path: 'fields', message })) });
      let templateId: string | undefined, templateVersion: number | undefined;
      if (input.saveAs) {
        const t = await data.uploads.saveMapping(u.source, input.saveAs, input.fields, signatureFor(input.fields, headers));
        templateId = t.id; templateVersion = t.version;
      }
      const ok = await data.uploads.transition(id, ['needs_mapping'], {
        status: 'processing', step: 'detect', progress: 30, mapping: input.fields, revision: { increment: 1 },
        ...(templateId ? { templateId, templateVersion } : {}),
      });
      await data.event('upload.mapping_confirmed', p.user.id, id, ctx.requestId, { saved: Boolean(input.saveAs) });
      return { upload: (await data.uploads.get(id))!, queued: ok };
    });
    if (queued) await this.enqueue(ctx.tenantId, upload.id, upload.revision);
    return view(upload);
  }

  async discard(ctx: RequestContext, id: string) {
    const key = await this.auth.authenticated(ctx, { permission: 'uploads.discard', mutation: true }, async (data, p) => {
      const u = await data.uploads.get(id);
      if (!u) throw new NotFoundException('Upload not found');
      const ok = await data.uploads.transition(id, ['uploading', 'needs_mapping', 'needs_review', 'rejected', 'failed'], { status: 'discarded', step: null });
      if (!ok) throw new ConflictException(`An upload that is ${u.status} cannot be discarded`);
      await data.uploads.clearStaging(id);
      await data.event('upload.discarded', p.user.id, id, ctx.requestId);
      return u.storageKey;
    });
    await this.storage.delete(key).catch(() => this.log.warn(`Could not delete object for upload ${id}`));
    return { success: true };
  }

  private async enqueue(tenantId: string, uploadId: string, revision: number) {
    try {
      await this.queue.enqueueProcess({ tenantId, uploadId, revision });
    } catch {
      // The record stays "processing"; the worker's recovery sweep re-queues it. Don't fail the user's request.
      this.log.error(`Could not enqueue upload ${uploadId}; recovery sweep will retry`);
    }
  }
}
