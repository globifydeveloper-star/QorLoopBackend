// The in-app reset (ADR 022) runs the SQL of scripts/dev/store-reset-plan.mjs (ADR 018), the one plan shared with the
// operations script and its PGlite tests, through the Prisma transaction of the request that asked for it.
import { randomUUID } from 'node:crypto';
import type { Prisma } from './generated/client.js';
import * as plan from '../../../scripts/dev/store-reset-plan.mjs';

type Row = Record<string, unknown>;
type Transaction = Prisma.TransactionClient;
export type ResetQuery = (text: string, params?: unknown[]) => Promise<Row[]>;

export const ResetRefused = plan.ResetRefused;
export const RESET_ACTION = plan.RESET_ACTION;
export const storagePrefixes = (tenantId: string): { root: string; delete: string[] } => plan.storagePrefixes(tenantId);

/** The plan's `q`: every statement it sends returns rows; ANALYZE (outside a transaction) does not. */
export function resetQuery(client: Pick<Transaction, '$queryRawUnsafe' | '$executeRawUnsafe'>): ResetQuery {
  return async (text, params = []) => /^\s*ANALYZE\b/i.test(text)
    ? (await client.$executeRawUnsafe(text, ...params), [])
    : client.$queryRawUnsafe<Row[]>(text, ...params);
}

/** Friendly totals for the confirmation screen, from the per-table counts the reset would delete. */
export function resetSummary(t: Record<string, number>) {
  const n = (...tables: string[]) => tables.reduce((a, k) => a + (t[k] ?? 0), 0);
  return {
    products: n('products'), categories: n('categories'), uploads: n('uploads'), generatedFiles: n('generated_files'),
    marketplaceListings: n('listings'), comparisonRows: n('recon_rows'),
    priceRules: n('product_price_rules', 'category_price_rules', 'marketplace_price_rules', 'category_mappings'),
    offers: n('product_offers'), exportValues: n('marketplace_value_overrides'), stockEdits: n('catalogue_stock_edits'),
    notifications: n('notifications'), activityEntries: n('audit_events'),
    totalRows: Object.values(t).reduce((a, b) => a + b, 0),
  };
}

export async function resetPreview(tx: Transaction, tenantId: string) {
  const q = resetQuery(tx);
  return { tables: await plan.deleteCounts(q, tenantId) as Record<string, number>, inFlightUploads: await plan.inFlightUploads(q, tenantId) as number };
}

/**
 * Deletes the store's business data inside `tx`, which must already hold the tenant row lock (Database.run does). Throws
 * ResetRefused, and the caller's transaction rolls back, when an upload is still being processed, the recon is running,
 * the schema does not match the plan or the verification fails.
 */
export async function resetStoreData(tx: Transaction, tenantId: string, input: { actorId: string; requestId: string }) {
  const q = resetQuery(tx);
  const busy = await plan.inFlightUploads(q, tenantId);
  if (busy > 0) throw new plan.ResetRefused(`${busy === 1 ? 'An upload is' : `${busy} uploads are`} still being processed. Wait until ${busy === 1 ? 'it finishes' : 'they finish'}, then try again. Nothing was changed.`);
  const result = await plan.resetTenantInTransaction(q, {
    tenantId, eventId: randomUUID(), actorId: input.actorId, requestId: input.requestId, source: 'app',
    busyMessage: 'The comparison is being recalculated right now. Try again in a minute. Nothing was changed.',
  });
  return { eventId: result.eventId as string, deleted: result.deleted as Record<string, number> };
}

/** After COMMIT, outside any transaction: fresh planner statistics for the emptied tables (as the script does). */
export async function analyzeAfterReset(client: Pick<Transaction, '$queryRawUnsafe' | '$executeRawUnsafe'>) {
  return plan.analyzeEmptiedTables(resetQuery(client)) as Promise<number>;
}
