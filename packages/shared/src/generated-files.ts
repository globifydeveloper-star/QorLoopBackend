import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Queue, type ConnectionOptions } from 'bullmq';
import type { Database, TenantData } from '../../db/src/database.js';
import { GenerationBlocked, duplicateRowsWarning, fileValues, planGeneratedFile, selectedForFile, type GenerateParams } from '../../core/src/generated-files.js';
import { ParseError, readSpreadsheetValues } from '../../core/src/upload/parse.js';
import { extensionOf, inspectFile } from '../../core/src/upload/safety.js';
import { UPLOAD_LIMITS } from '../../core/src/upload/constants.js';
import type { ObjectStorage } from './storage.js';
import { JOB_DEFAULTS } from './queue.js';

export const GENERATED_FILES_QUEUE = 'generated-files';
export const GENERATION_FAILURE_MESSAGE = 'We could not generate this file. Please try again.';
export interface GenerateFileJob extends GenerateParams {
  tenantId: string; actorId: string; requestId: string; requestedAt: string;
  /** exportToken of the inputs the API checked (migration 202611100001): the worker refuses inputs that moved since. */
  exportToken?: string;
}
export interface GenerationJobStatus { state: 'queued' | 'running' | 'done' | 'failed'; fileId?: string; message?: string }
/** Same request in the same minute = the same job; with an exportToken, an edit within that minute makes a new one. */
export const generationJobId = (job: GenerateFileJob) => {
  const minute = Math.floor(new Date(job.requestedAt).getTime() / 60_000);
  return `generate-${job.tenantId}-${job.marketplaceId}-${job.kind}-${job.scope}-${job.reference}-${minute}${job.exportToken ? `-${job.exportToken.slice(0, 16)}` : ''}`;
};
export const STALE_EXPORT_MESSAGE = 'The catalogue or export values changed since this file was requested. Preview and generate it again.';

/**
 * A fingerprint of everything the file would write for these parameters: the source upload, and per row (by product)
 * the identifier, the selection flags and the written price and availability. Preview hands it out; generation and the
 * worker (before it stores the file, under the tenant lock) refuse inputs whose fingerprint moved.
 */
export function exportToken(inputs: Pick<GenerationInputs, 'upload' | 'rows' | 'referenceUsed'>, p: GenerateParams): string {
  const rows = [...inputs.rows].sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0)).map(r => {
    const v = fileValues(r, p);
    return [r.productId, r.marketplaceProductId, selectedForFile(r, p) ? 1 : 0, v.price === null ? null : Math.round(v.price * 1000), v.available,
      r.actualPrice === null ? null : Math.round(r.actualPrice * 1000), r.status];
  });
  return createHash('sha256').update(JSON.stringify([inputs.upload.id, inputs.referenceUsed, p.kind, p.scope, p.marketplaceId, rows])).digest('hex');
}
/** A stable UUID gives retries the same database row and object key without a schema change. */
export function generatedFileId(jobId: string): string {
  const hex = createHash('sha256').update(jobId).digest('hex').slice(0, 32).split('');
  hex[12] = '5'; hex[16] = '8';
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
export interface GeneratedFilesQueue {
  enqueue(job: GenerateFileJob): Promise<string>;
  status(jobId: string, tenantId: string): Promise<GenerationJobStatus | null>;
}
export class BullGeneratedFilesQueue implements GeneratedFilesQueue {
  private readonly queue: Queue<GenerateFileJob, { fileId: string }>;
  constructor(connection: ConnectionOptions) {
    this.queue = new Queue(GENERATED_FILES_QUEUE, { connection, defaultJobOptions: JOB_DEFAULTS });
  }
  async enqueue(job: GenerateFileJob) {
    const jobId = generationJobId(job);
    await this.queue.add('generate-file', job, { jobId });
    return jobId;
  }
  async status(jobId: string, tenantId: string): Promise<GenerationJobStatus | null> {
    const job = await this.queue.getJob(jobId);
    if (!job || job.data.tenantId !== tenantId) return null;
    const state = await job.getState();
    if (state === 'unknown') return null;
    if (state === 'completed') return { state: 'done', fileId: job.returnvalue?.fileId };
    // Never return failedReason/stacktrace: driver and storage errors may contain data or credentials.
    if (state === 'failed') return { state: 'failed', message: GENERATION_FAILURE_MESSAGE };
    return { state: state === 'active' ? 'running' : 'queued' };
  }
  close() { return this.queue.close(); }
}
export class InlineGeneratedFilesQueue implements GeneratedFilesQueue {
  readonly jobs = new Map<string, GenerateFileJob>();
  readonly states = new Map<string, GenerationJobStatus>();
  handler?: (job: GenerateFileJob) => Promise<{ fileId: string }>;
  async enqueue(job: GenerateFileJob) {
    const id = generationJobId(job);
    if (this.jobs.has(id)) return id;
    this.jobs.set(id, job); this.states.set(id, { state: 'queued' });
    if (this.handler) await this.run(id);
    return id;
  }
  async run(id: string) {
    this.states.set(id, { state: 'running' });
    try { this.states.set(id, { state: 'done', ...await this.handler!(this.jobs.get(id)!) }); }
    catch { this.states.set(id, { state: 'failed', message: GENERATION_FAILURE_MESSAGE }); }
  }
  async status(id: string, tenantId: string) { return this.jobs.get(id)?.tenantId === tenantId ? this.states.get(id) ?? null : null; }
}

export async function loadGenerationInputs(data: TenantData, marketplaceId: string, reference?: GenerateParams['reference']) {
  const upload = await data.generatedFiles.latestApplied(marketplaceId);
  if (!upload) throw new GenerationBlocked('There is no applied upload for this marketplace. Upload and apply a marketplace file first.');
  const settings = await data.pricing.settings();
  const referenceUsed = reference ?? (settings?.compareReferenceDefault === 'erp' ? 'erp' : 'marketplace');
  // availability and stock issue follow the reference: catalogue stock (marketplace) or ERP stock (erp), ADR 017
  // export values in effect are written in every file (migration 202611100001); pinned prices use the store tolerance
  const { priceTolerance } = await data.recon.settings();
  const rows = await data.generatedFiles.reconRows(marketplaceId, referenceUsed, priceTolerance);
  if (!rows.length) throw new GenerationBlocked('This marketplace has not been reconciled yet.');
  return { upload, rows, referenceUsed };
}
export type GenerationInputs = Awaited<ReturnType<typeof loadGenerationInputs>>;

/** No database lock is held while downloading, parsing or serialising a workbook. Temp files are always removed. */
export async function prepareGeneration(storage: ObjectStorage, inputs: GenerationInputs, p: GenerateParams) {
  const { upload, rows } = inputs;
  const ext = extensionOf(upload.fileName);
  if (ext !== '.xlsx' && ext !== '.csv') throw new GenerationBlocked('Generation supports .xlsx and .csv originals. Upload a fresh marketplace file in one of these formats.');
  const label = { talabat: 'Talabat', snoonu: 'Snoonu', rafeeq: 'Rafeeq', keeta: 'Keeta' }[p.marketplaceId];
  const missing = () => new GenerationBlocked(`The original is no longer in storage. Upload a fresh ${label} file.`);
  const head = await storage.head(upload.storageKey);
  if (!head) throw missing();
  if (head.size > UPLOAD_LIMITS.maxBytes) throw new GenerationBlocked('The original file is larger than 25 MB. Upload a fresh marketplace file.');
  const dir = await mkdtemp(join(tmpdir(), 'qorloop-generated-'));
  try {
    const path = join(dir, `original${ext}`);
    try { await storage.downloadTo(upload.storageKey, path); }
    catch (e) {
      if (!await storage.head(upload.storageKey)) throw missing();
      throw e;
    }
    const buffer = await readFile(path);
    const inspected = inspectFile(buffer, upload.fileName);
    if (!inspected.ok) throw new GenerationBlocked(inspected.reason);
    const sheet = await readSpreadsheetValues({ path, buffer }, ext === '.csv' ? 'csv' : 'xlsx');
    const plan = planGeneratedFile(sheet, upload.mapping, upload.headers, rows, p);
    const duplicates = duplicateRowsWarning(label, plan.duplicateRows);
    const warnings = duplicates ? [duplicates] : [];
    return ext === '.csv' ? { plan, warnings, ext: '.csv' as const, format: 'csv' as const } : { plan, warnings, ext: '.xlsx' as const, format: 'xlsx' as const };
  } catch (e) {
    if (e instanceof ParseError) throw new GenerationBlocked(e.code === 'no_header'
      ? "The source file's headers no longer include the mapped columns. Upload a fresh marketplace file."
      : `The original file could not be read. Upload a fresh ${label} file.`);
    throw e;
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export async function generationInputs(database: Database, tenantId: string, p: GenerateParams) {
  return database.readSnapshot(tenantId, d => loadGenerationInputs(d, p.marketplaceId, p.reference));
}
