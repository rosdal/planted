-- Additive only: a new table, and a column with a constant default (metadata-only since PG 11).
-- Rooms created before this have no links, so they can't be opened any more and expire with
-- the 30-day idle job.
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
CREATE TABLE "room_links" (
	"id" text PRIMARY KEY NOT NULL,
	"room_id" text NOT NULL,
	"role" text NOT NULL,
	"key_hash" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "room_links_role_check" CHECK ("room_links"."role" in ('edit', 'view'))
);
--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "epoch" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "room_links" ADD CONSTRAINT "room_links_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "room_links_room_id_idx" ON "room_links" USING btree ("room_id");