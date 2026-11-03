-- Additive indexes only. No tables, columns, existing indexes, or data are changed.
CREATE INDEX "audit_events_tenant_entity_time_idx"
  ON "audit_events" ("tenant_id", "entity_id", "created_at" DESC, "id" DESC);

CREATE INDEX "audit_events_tenant_time_id_idx"
  ON "audit_events" ("tenant_id", "created_at" DESC, "id" DESC);

-- Bulk events have up to 5,000 compact change arrays. Index their product membership
-- using containment; do not expand every event's JSON before filtering by product.
-- This expression index is maintained in SQL (Prisma cannot model expression indexes).
CREATE INDEX "audit_events_bulk_changes_gin_idx"
  ON "audit_events" USING GIN (("details" -> 'changes') jsonb_path_ops)
  WHERE "action" = 'pricing.bulk_applied';
