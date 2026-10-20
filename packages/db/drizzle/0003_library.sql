ALTER TABLE "assets" ADD COLUMN "status" text DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "original_name" text;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "upload_id" text;--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "provider_op" jsonb;--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "asset_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "auto_tag_uploads" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "assets_user_status_created_idx" ON "assets" USING btree ("user_id","status","created_at");--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_status_check" CHECK ("assets"."status" in ('uploading', 'processing', 'ready', 'failed'));--> statement-breakpoint
-- trigram для неточного пошуку за тегами (вираз — тому вручну, поза Drizzle-схемою)
CREATE INDEX "assets_tags_trgm_idx" ON "assets" USING gin (vf_tags_text("tags") gin_trgm_ops);
