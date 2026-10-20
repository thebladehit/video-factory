CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"format" text NOT NULL,
	"fps" integer DEFAULT 30 NOT NULL,
	"timeline" jsonb NOT NULL,
	"timeline_version" integer DEFAULT 1 NOT NULL,
	"asset_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"topic" text,
	"base_language" text DEFAULT 'uk' NOT NULL,
	"languages" text[] DEFAULT '{uk}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_format_check" CHECK ("projects"."format" in ('9:16', '16:9')),
	CONSTRAINT "projects_status_check" CHECK ("projects"."status" in ('draft', 'ready', 'published'))
);
--> statement-breakpoint
CREATE TABLE "renders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"preset" text NOT NULL,
	"language" text,
	"timeline_snapshot" jsonb NOT NULL,
	"timeline_version" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"job_id" uuid,
	"output_asset_id" uuid,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "renders_preset_check" CHECK ("renders"."preset" in ('final', 'draft')),
	CONSTRAINT "renders_status_check" CHECK ("renders"."status" in ('queued', 'running', 'done', 'failed', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "has_audio" boolean;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "peaks_key" text;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renders" ADD CONSTRAINT "renders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renders" ADD CONSTRAINT "renders_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renders" ADD CONSTRAINT "renders_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renders" ADD CONSTRAINT "renders_output_asset_id_assets_id_fk" FOREIGN KEY ("output_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "projects_user_updated_idx" ON "projects" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "projects_asset_ids_idx" ON "projects" USING gin ("asset_ids");--> statement-breakpoint
CREATE INDEX "renders_project_created_idx" ON "renders" USING btree ("project_id","created_at");--> statement-breakpoint
-- у фото звуку немає; відео/аудіо дорахує asset.analyze
UPDATE "assets" SET "has_audio" = false WHERE "kind" = 'image';
