import { Prisma } from './generated/client.js';
import { GROUP_ACTIONS, PRICE_FIELDS, STOCK_FIELDS, type ActivityGroup } from '../../core/src/activity.js';

export type ActivityFilter = {
  productId?: string; includeTenantUploads?: boolean; eventType?: ActivityGroup; actorId?: string; from?: string; to?: string;
  after?: { time: string; id: string }; limit: number;
};
export type ActivityRecord = {
  id: string; time: string; actorId: string | null; actorName: string | null; actorEmail: string | null;
  action: string; entityId: string | null; details: unknown; scope: 'tenant' | 'product';
};

/** Exported so the test EXPLAIN uses exactly the production query. No JSON expansion before indexed membership. */
export function activitySql(tenantId: string, q: ActivityFilter) {
  const filters = [Prisma.sql`e.tenant_id = ${tenantId}::uuid`];
  if (q.actorId) filters.push(q.actorId === 'system' ? Prisma.sql`e.actor_id IS NULL` : Prisma.sql`e.actor_id = ${q.actorId}::uuid`);
  if (q.from) filters.push(Prisma.sql`e.created_at >= ${q.from}::timestamptz`);
  if (q.to) filters.push(Prisma.sql`e.created_at <= ${q.to}::timestamptz`);
  if (q.after) filters.push(Prisma.sql`(e.created_at, e.id) < (${q.after.time}::timestamptz, ${q.after.id}::uuid)`);
  if (q.eventType) {
    const group = q.eventType, field = Prisma.sql`e.details ->> 'field'`;
    const fieldMatch = group === 'price' ? Prisma.sql`${field} = ANY(${[...PRICE_FIELDS]}::text[])`
      : group === 'stock_uploads' ? Prisma.sql`${field} = ANY(${[...STOCK_FIELDS]}::text[])`
      : group === 'catalogue' ? Prisma.sql`coalesce(${field}, '') <> ALL(${[...PRICE_FIELDS, ...STOCK_FIELDS]}::text[])` : Prisma.sql`false`;
    filters.push(Prisma.sql`(e.action = ANY(${[...GROUP_ACTIONS[group]]}::text[]) OR (e.action = 'product.field_changed' AND ${fieldMatch}))`);
  }
  const common = Prisma.join(filters, ' AND ');
  const branch = (scope: 'product' | 'tenant', condition: Prisma.Sql) => Prisma.sql`(
    SELECT e.*, ${scope}::text AS scope FROM audit_events e WHERE ${common} AND ${condition}
    ORDER BY e.created_at DESC, e.id DESC LIMIT ${q.limit})`;
  const branches = q.productId ? [
    branch('product', Prisma.sql`e.entity_id = ${q.productId}::uuid AND e.action LIKE 'product.%'`),
    branch('product', Prisma.sql`e.action = 'pricing.bulk_applied' AND (e.details -> 'changes') @> ${JSON.stringify([[q.productId]])}::jsonb`),
    ...(q.includeTenantUploads ? [branch('tenant', Prisma.sql`e.action LIKE 'upload.%'`)] : []),
  ] : [branch('tenant', Prisma.sql`true`)];
  return Prisma.sql`SELECT c.id, to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS time,
    c.actor_id AS "actorId", u.name AS "actorName", u.email AS "actorEmail", c.action, c.entity_id AS "entityId", c.details, c.scope
    FROM (${Prisma.join(branches, ' UNION ALL ')}) c LEFT JOIN users u ON u.tenant_id = c.tenant_id AND u.id = c.actor_id
    ORDER BY c.created_at DESC, c.id DESC LIMIT ${q.limit}`;
}
export class ActivityRepository {
  constructor(private readonly tenantId: string, private readonly tx: Prisma.TransactionClient) {}
  list(q: ActivityFilter) { return this.tx.$queryRaw<ActivityRecord[]>(activitySql(this.tenantId, q)); }
}
