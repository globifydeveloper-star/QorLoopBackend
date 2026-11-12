import type { Database } from '../../../packages/db/src/database.js';
import { randomUUID } from 'node:crypto';
import { GenerationBlocked, generatedFileName, writeGeneratedFile } from '../../../packages/core/src/generated-files.js';
import {
  exportToken, generationInputs, generationJobId, generatedFileId, loadGenerationInputs, prepareGeneration, GENERATION_FAILURE_MESSAGE, STALE_EXPORT_MESSAGE, type GenerateFileJob,
} from '../../../packages/shared/src/generated-files.js';
import { storageKeys, type ObjectStorage } from '../../../packages/shared/src/storage.js';
import { XLSX_CONTENT_TYPE } from '../../../packages/core/src/upload/error-report.js';
import { describeApplyError } from './apply-upload.js';

export interface GenerationDeps {
  database: Database; storage: ObjectStorage;
  log?: { info(o: object, m?: string): void; warn(o: object, m?: string): void };
}

/** Stable row ID + a short transactional recheck make a retried job create exactly one file and success event. */
export async function generateFile(deps: GenerationDeps, job: GenerateFileJob): Promise<{ fileId: string }> {
  const started = Date.now();
  const id = generatedFileId(generationJobId(job));
  let phase = 'load';
  const timings: Record<string, number> = {};
  let mark = started;
  const enter = (next: string) => { timings[phase] = Date.now() - mark; mark = Date.now(); phase = next; };
  try {
    const prior = await deps.database.run(job.tenantId, d => d.generatedFiles.get(id));
    if (prior) return { fileId: prior.id };
    const inputs = await generationInputs(deps.database, job.tenantId, job);
    // the inputs the API checked (preview or request time) must still be the inputs now (migration 202611100001)
    const token = exportToken(inputs, job);
    if (job.exportToken && job.exportToken !== token) throw new GenerationBlocked(STALE_EXPORT_MESSAGE);
    enter('round-trip');
    const { plan, warnings, ext, format } = await prepareGeneration(deps.storage, inputs, job);
    enter('serialize');
    const body = await writeGeneratedFile(plan, format);
    const generatedAt = new Date();
    const label = { talabat: 'Talabat', snoonu: 'Snoonu', rafeeq: 'Rafeeq', keeta: 'Keeta' }[job.marketplaceId];
    const fileName = generatedFileName(label, job.kind, generatedAt, ext);
    // An attempt owns its object. A timed-out/stalled attempt must never overwrite/delete a later winner's file.
    const storageKey = storageKeys.generated(job.tenantId, randomUUID(), ext);
    const counts = {
      productCount: plan.productCount, rowsToWrite: plan.rowsToWrite, priceChanges: plan.priceChanges, availabilityChanges: plan.availabilityChanges, notInFile: plan.notInFile,
      duplicateProducts: plan.duplicateRows?.products ?? 0, duplicateExtraRows: plan.duplicateRows?.extraRows ?? 0,
    };
    enter('store');
    await deps.database.run(job.tenantId, async d => {
      // Another attempt might have finished while this one was parsing. It must not overwrite its object.
      if (await d.generatedFiles.get(id)) return;
      // Nothing the file writes may have changed while it was being made (an edit, an apply, a recompute): checked
      // under the tenant row lock that every such writer takes, so a stale file is never stored.
      if (exportToken(await loadGenerationInputs(d, job.marketplaceId, job.reference), job) !== token) throw new GenerationBlocked(STALE_EXPORT_MESSAGE);
      try {
        await deps.storage.put(storageKey, body, format === 'xlsx' ? XLSX_CONTENT_TYPE : 'text/csv; charset=utf-8');
        await d.generatedFiles.create({
          id, marketplaceId: job.marketplaceId, kind: job.kind, scope: job.scope, reference: job.reference,
          fileName, storageKey, productCount: plan.productCount, generatedById: job.actorId, generatedAt,
          expiresAt: new Date(generatedAt.getTime() + 30 * 86_400_000),
        });
        await d.event('file.generated', job.actorId, id, job.requestId, {
          marketplaceId: job.marketplaceId, kind: job.kind, scope: job.scope, reference: job.reference, sourceUploadId: inputs.upload.id, ...counts, warnings,
        });
      } catch (e) {
        // This key belongs only to this attempt, including if the database transaction has timed out.
        await deps.storage.delete(storageKey).catch(() => undefined);
        throw e;
      }
    });
    enter('done');
    deps.log?.info({ tenantId: job.tenantId, fileId: id, ...counts, ms: Date.now() - started, timings }, 'Marketplace file generated');
    return { fileId: id };
  } catch (e) {
    const failure = { ...describeApplyError(e, phase, Date.now() - started), message: e instanceof GenerationBlocked ? e.message : GENERATION_FAILURE_MESSAGE };
    deps.log?.warn({ tenantId: job.tenantId, fileId: id, ...failure }, 'Marketplace file generation failed');
    await deps.database.run(job.tenantId, d => d.event('file.generation_failed', job.actorId, id, job.requestId, { ...failure }))
      .catch(() => deps.log?.warn({ tenantId: job.tenantId, fileId: id }, 'Could not record generation failure'));
    // BullMQ persists this message and stack. Never give it the original exception or its cause.
    throw new Error(failure.message);
  }
}
