ALTER TABLE products
  ADD COLUMN blocked_at timestamptz,
  ADD COLUMN blocked_reason text,
  ADD COLUMN blocked_by uuid;

ALTER TABLE products
  ADD CONSTRAINT products_blocked_reason_check
  CHECK (blocked_reason IS NULL OR blocked_reason IN ('old', 'seasonal', 'other')),
  ADD CONSTRAINT products_blocked_metadata_check
  CHECK ((blocked_at IS NULL AND blocked_reason IS NULL AND blocked_by IS NULL)
      OR (blocked_at IS NOT NULL AND blocked_reason IS NOT NULL));

CREATE INDEX products_tenant_blocked_at_idx ON products (tenant_id, blocked_at) WHERE blocked_at IS NOT NULL;
