-- Trigram search on product names (docs/04-data-model.md "Indexes to have from day one").
-- Needs the pg_trgm contrib extension; the embedded test database skips migrations ending in _extensions.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "products_name_en_trgm_idx" ON "products" USING gin ("name_en" gin_trgm_ops);
