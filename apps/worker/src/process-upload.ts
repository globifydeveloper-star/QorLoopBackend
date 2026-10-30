import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from '../../../packages/db/src/database.js';
import type { ObjectStorage } from '../../../packages/shared/src/storage.js';
import type { ProcessUploadJob } from '../../../packages/shared/src/queue.js';
import { inspectFile, extensionOf } from '../../../packages/core/src/upload/safety.js';
import { ParseError, parseSpreadsheet } from '../../../packages/core/src/upload/parse.js';
import { detectTemplate, looksLikeOtherSource, suggestMapping, validateMapping, type TemplateLike } from '../../../packages/core/src/upload/mapping.js';
import { exceedsInvalidShare, mapRows, type ErpRow, type MarketplaceRow } from '../../../packages/core/src/upload/validate.js';
import { buildErpReview, buildMarketplaceReview, type Review, type StoredReviewSummary } from '../../../packages/core/src/upload/review.js';
import { UPLOAD_LIMITS } from '../../../packages/core/src/upload/constants.js';

export interface ProcessDeps {
  database: Database;
  storage: ObjectStorage;
  log?: { info(o: object, m?: string): void; warn(o: object, m?: string): void };
}

export type ProcessOutcome = 'needs_review' | 'needs_mapping' | 'rejected' | 'skipped';

const SOURCE_LABELS: Record<string, string> = { erp: 'ERP', talabat: 'Talabat', snoonu: 'Snoonu', rafeeq: 'Rafeeq', keeta: 'Keeta' };
const MAX_STORED_ERRORS = 5000;


/**
 * Pipeline (docs 03 "File pipeline"): scan → check → read → detect → validate → review.
 * Heavy work (download, parse, diff) runs OUTSIDE database transactions; each state change is a short
 * transaction. Safe to run twice: stale or already-handled jobs return 'skipped'.
 * Rejections are normal outcomes (no retry); unexpected errors are thrown so BullMQ retries the job.
 */
export async function processUpload(deps: ProcessDeps, job: ProcessUploadJob): Promise<ProcessOutcome> {
  const { database, storage } = deps;
  const { tenantId, uploadId } = job;
  const upload = await database.run(tenantId, d => d.uploads.get(uploadId));
  if (!upload || upload.status !== 'processing' || upload.revision !== job.revision) return 'skipped';

  const step = (name: string, progress: number) => database.run(tenantId, d => d.uploads.progress(uploadId, name, progress));
  const reject = async (reason: string, errors: { row: number; column: string | null; value: string | null; reason: string }[] = [], stepName = 'check'): Promise<ProcessOutcome> => {
    await database.run(tenantId, async d => {
      if (errors.length) await d.uploads.replaceReview(uploadId, [], errors.slice(0, MAX_STORED_ERRORS));
      const ok = await d.uploads.transition(uploadId, ['processing'], { status: 'rejected', step: stepName, errorMessage: reason });
      if (ok) await d.event('upload.rejected', null, uploadId, undefined, { reason });
    });
    return 'rejected';
  };

  const dir = await mkdtemp(join(tmpdir(), 'qorloop-upload-'));
  try {
    // 1. Scan: fetch the original and verify it is a safe, real spreadsheet.
    await step('scan', 5);
    const path = join(dir, 'original' + extensionOf(upload.fileName));
    await storage.downloadTo(upload.storageKey, path);
    const buffer = await readFile(path);
    if (buffer.length !== upload.size) return await reject('The stored file does not match the declared size', [], 'scan');
    const sha = createHash('sha256').update(buffer).digest('hex');
    const safety = inspectFile(buffer, upload.fileName);
    if (!safety.ok) return await reject(safety.reason, [], 'scan');

    // 2. Check + 3. Read: parse up to 50,000 rows.
    await step('check', 15);
    let sheet;
    try {
      await step('read', 25);
      sheet = await parseSpreadsheet({ path, buffer: safety.format === 'xls' ? undefined : buffer }, safety.format);
    } catch (e) {
      if (e instanceof ParseError) return await reject(e.message, [], 'read');
      throw e;
    }
    if (sheet.rows.length === 0) return await reject('The file has a header row but no data rows', [], 'read');

    // 4. Detect the layout: a saved/built-in mapping, the user's confirmed mapping, or ask for one.
    await step('detect', 45);
    const templates = await database.run(tenantId, d => d.uploads.allMappings());
    const asLike = (t: (typeof templates)[number]): TemplateLike => ({ id: t.id, source: t.source, name: t.name, version: t.version, fields: t.fields as Record<string, string>, signature: t.signature });
    const likes = templates.map(asLike);
    let fields = (upload.mapping as Record<string, string> | null) ?? null;
    let templateId = upload.templateId, templateVersion = upload.templateVersion;
    if (!fields) {
      const hit = detectTemplate(likes, upload.source, sheet.headers);
      if (hit) { fields = hit.fields; templateId = hit.id; templateVersion = hit.version; }
    }
    if (!fields) {
      const other = looksLikeOtherSource(likes, upload.source, sheet.headers);
      if (other) return await reject(`This looks like a ${SOURCE_LABELS[other] ?? other} file, not a ${SOURCE_LABELS[upload.source] ?? upload.source} file`, [], 'detect');
      const suggestion = suggestMapping(upload.source, sheet.headers);
      await database.run(tenantId, async d => {
        await d.uploads.transition(uploadId, ['processing'], {
          status: 'needs_mapping', step: 'detect', progress: 50, headers: sheet.headers, sheetName: sheet.sheetName,
          mappingSuggestion: suggestion as unknown as object, checksumSha256: sha,
        });
        await d.event('upload.needs_mapping', null, uploadId);
      });
      return 'needs_mapping';
    }
    const problems = validateMapping(upload.source, fields, sheet.headers);
    if (problems.length) return await reject(`The file layout no longer matches the mapping: ${problems[0]}`, [], 'detect');

    // 5. Validate rows. More than 20% invalid rejects the whole file (blueprint J1).
    await step('validate', 60);
    const mapped = mapRows(upload.source, sheet.rows, fields, sheet.rowNumbers);
    const rowsRead = sheet.rows.length;
    const errRows = mapped.errors.map(e => ({ row: e.row, column: e.column || null, value: e.value || null, reason: e.reason }));
    if (exceedsInvalidShare(rowsRead, mapped.errors.length, UPLOAD_LIMITS.maxInvalidRowShare)) {
      return await reject(`${mapped.errors.length.toLocaleString('en')} of ${rowsRead.toLocaleString('en')} rows are invalid (more than 20%)`, errRows, 'read');
    }

    // 6. Review: compare with the tenant's catalogue. Nothing is written to the catalogue until the user applies.
    await step('review', 75);
    const [products, listings] = await database.run(tenantId, async d => [
      await d.uploads.productSnapshot(),
      upload.source === 'erp' ? [] : await d.uploads.listingSnapshot(upload.source),
    ] as const);
    const catalog = products.map(p => ({ id: p.id, normalizedBarcode: p.normalizedBarcode, sku: p.sku, nameEn: p.nameEn, erpPrice: p.erpPrice.toNumber(), erpStock: p.erpStock, inLatestErpFile: p.inLatestErpFile }));
    const contains = upload.contains === 'partial' ? 'partial' : 'full';
    const review: Review = upload.source === 'erp'
      ? buildErpReview(mapped.erpRows as ErpRow[], rowsRead, errRows.map(e => ({ row: e.row, column: e.column ?? '', value: e.value ?? '', reason: e.reason })), catalog, contains, fields)
      : buildMarketplaceReview(
          mapped.marketplaceRows as MarketplaceRow[], rowsRead, errRows.map(e => ({ row: e.row, column: e.column ?? '', value: e.value ?? '', reason: e.reason })),
          catalog, listings.map(l => ({ productId: l.productId, marketplaceProductId: l.marketplaceProductId, price: l.price.toNumber(), available: l.available })), contains, fields,
        );

    const summary: StoredReviewSummary = { ...review.summary, contains, firstImport: upload.source === 'erp' && products.length === 0, missingSample: review.missing.slice(0, 20) };
    const storedErrors = review.errors.map(e => ({ row: e.row, column: e.column || null, value: e.value || null, reason: e.reason })).slice(0, MAX_STORED_ERRORS);
    await database.run(tenantId, async d => {
      await d.uploads.replaceReview(uploadId, review.rows.map(r => ({
        rowNumber: r.rowNumber, matchProductId: r.productId, changeType: r.changeType,
        parsed: { data: r.parsed, change: { price: r.price, stock: r.stock, availability: r.availability } } as never,
      })), storedErrors);
      const ok = await d.uploads.transition(uploadId, ['processing'], {
        status: 'needs_review', step: 'review', progress: 100, headers: sheet.headers, sheetName: sheet.sheetName,
        mapping: fields as never, summary: summary as never, checksumSha256: sha, errorMessage: null,
        ...(templateId ? { templateId, templateVersion } : {}),
      });
      if (ok) await d.event('upload.reviewed', null, uploadId, undefined, { ...review.summary });
    });
    deps.log?.info({ tenantId, uploadId, ...review.summary }, 'Upload ready for review');
    return 'needs_review';
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Called when BullMQ has exhausted every attempt. The message is generic; details stay in logs. */
export async function markFailed(deps: ProcessDeps, job: ProcessUploadJob) {
  await deps.database.run(job.tenantId, async d => {
    const ok = await d.uploads.transition(job.uploadId, ['processing'], { status: 'failed', errorMessage: 'We could not process this file. Please try again or contact support.' });
    if (ok) await d.event('upload.failed', null, job.uploadId);
  });
}

/**
 * Re-queue uploads stuck in "processing" or "applying" (e.g. the API crashed between commit and enqueue).
 * Enqueue is idempotent: the job ID is deterministic, so a job that is still running is not duplicated.
 */
export async function recoverStuckUploads(deps: ProcessDeps, enqueue: (j: ProcessUploadJob, kind: 'process' | 'apply') => Promise<void>, olderThanMs = 10 * 60_000) {
  const cutoff = new Date(Date.now() - olderThanMs);
  let count = 0;
  for (const tenantId of await deps.database.tenantsWithStuckUploads(cutoff)) {
    const stuck = await deps.database.run(tenantId, d => d.uploads.stuck(cutoff));
    for (const s of stuck) { await enqueue({ tenantId, uploadId: s.id, revision: s.revision }, s.status === 'applying' ? 'apply' : 'process'); count++; }
  }
  return count;
}
