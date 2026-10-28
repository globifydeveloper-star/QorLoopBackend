-- Security invariants beyond Prisma's declarative schema vocabulary.
ALTER TABLE "tenants" ADD CONSTRAINT "tenant_status_valid" CHECK ("status" IN ('active', 'suspended'));
ALTER TABLE "users" ADD CONSTRAINT "user_email_normalized" CHECK ("email" = lower(btrim("email")));
ALTER TABLE "invitations" ADD CONSTRAINT "invitation_email_normalized" CHECK ("email" = lower(btrim("email")));
ALTER TABLE "invitations" ADD CONSTRAINT "invitation_pending_matches_email" CHECK ("pending_email" IS NULL OR "pending_email" = "email");
ALTER TABLE "invitations" ADD CONSTRAINT "invitation_lifecycle_valid" CHECK (
  NOT ("accepted_at" IS NOT NULL AND "revoked_at" IS NOT NULL)
  AND (("accepted_at" IS NULL AND "revoked_at" IS NULL) = ("pending_email" IS NOT NULL))
);
ALTER TABLE "sessions" ADD CONSTRAINT "session_assurance_valid" CHECK ("assurance" IN ('full', 'enrollment', 'challenge'));
ALTER TABLE "sessions" ADD CONSTRAINT "session_expiry_valid" CHECK ("expires_at" > "created_at");
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_valid" CHECK ("stale_hours" > 0 AND "price_tolerance" >= 0);

