-- Email one-time codes and device-bound sessions (plan Part 5, docs/plans/onboarding-redesign-backend.md; ADR 021).

-- A browser the user verified with a second factor. The cookie holds an opaque token; only its SHA-256 is stored.
-- Revoking a device deletes its row; its sessions go with it (sessions.device_id ON DELETE CASCADE).
CREATE TABLE "trusted_devices" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "token_hash" TEXT NOT NULL,
  "label" VARCHAR(200),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_used_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "trusted_devices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "trusted_devices_token_hash_key" ON "trusted_devices"("token_hash");
CREATE UNIQUE INDEX "trusted_devices_tenant_id_id_key" ON "trusted_devices"("tenant_id", "id");
CREATE INDEX "trusted_devices_tenant_id_user_id_idx" ON "trusted_devices"("tenant_id", "user_id");
ALTER TABLE "trusted_devices" ADD CONSTRAINT "trusted_devices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "trusted_devices" ADD CONSTRAINT "trusted_devices_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One pending second-factor check: a sign-in on a new device, a step-up inside a session, or an email change.
-- challenge_hash: SHA-256 of the challenge cookie (login), of a random value bound to the session (step_up) or of the
-- emailed link token (email_change). code_hash: HMAC-SHA256 of the emailed code with a key derived from AUTH_SECRET.
CREATE TABLE "login_challenges" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "purpose" TEXT NOT NULL,
  "method" TEXT NOT NULL,
  "challenge_hash" TEXT NOT NULL,
  "session_id" UUID,
  "trust_device" BOOLEAN NOT NULL DEFAULT true,
  "pending_email" TEXT,
  "code_hash" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "sends" INTEGER NOT NULL DEFAULT 0,
  "last_sent_at" TIMESTAMPTZ,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "consumed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "login_challenges_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "login_challenges_purpose_check" CHECK ("purpose" IN ('login', 'step_up', 'email_change')),
  CONSTRAINT "login_challenges_method_check" CHECK ("method" IN ('email', 'totp', 'link'))
);
CREATE UNIQUE INDEX "login_challenges_challenge_hash_key" ON "login_challenges"("challenge_hash");
CREATE INDEX "login_challenges_tenant_user_created_idx" ON "login_challenges"("tenant_id", "user_id", "created_at" DESC);
CREATE INDEX "login_challenges_tenant_sent_idx" ON "login_challenges"("tenant_id", "last_sent_at");
ALTER TABLE "login_challenges" ADD CONSTRAINT "login_challenges_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "login_challenges" ADD CONSTRAINT "login_challenges_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Sessions: bound to a trusted device (null: a shared-computer session), the last step-up, and a short user-agent label.
-- Existing sessions have no device and are signed out on deploy (owner decision D9).
DELETE FROM "sessions";
ALTER TABLE "sessions"
  ADD COLUMN "device_id" UUID,
  ADD COLUMN "step_up_at" TIMESTAMPTZ,
  ADD COLUMN "user_agent" VARCHAR(200);
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "trusted_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "sessions_device_id_idx" ON "sessions"("device_id");

-- Outbox: one-time-code mail goes first (priority 1) and is never sent after its code expired (discard_after).
ALTER TABLE "email_outbox"
  ADD COLUMN "priority" SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN "discard_after" TIMESTAMPTZ,
  ADD COLUMN "failed_at" TIMESTAMPTZ;
CREATE INDEX "email_outbox_due_idx" ON "email_outbox"("priority" DESC, "available_at") WHERE "delivered_at" IS NULL AND "failed_at" IS NULL;

-- Defined, not enabled, like every other tenant table (open gap G27).
CREATE POLICY tenant_isolation ON "trusted_devices" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON "login_challenges" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
