-- Additive only: a nullable column without a default is a metadata change, no rewrite.
-- Old code ignores it; rooms created before this keep NULL. Down: DROP COLUMN, which loses the
-- versions rooms pinned (they would then load the latest content).
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "content_version" text;
