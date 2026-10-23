CREATE TABLE "pipeline_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"settings" jsonb NOT NULL,
	"stage" text DEFAULT 'script' NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"error" text,
	"script_job_id" uuid,
	"assemble_job_id" uuid,
	"assembled_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_runs_project_id_unique" UNIQUE("project_id"),
	CONSTRAINT "pipeline_runs_stage_check" CHECK ("pipeline_runs"."stage" in ('script', 'review', 'produce', 'assemble', 'done')),
	CONSTRAINT "pipeline_runs_status_check" CHECK ("pipeline_runs"."status" in ('running', 'awaiting_review', 'done', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "pipeline_scenes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"segment_id" text NOT NULL,
	"position" integer NOT NULL,
	"visual_prompt" text DEFAULT '' NOT NULL,
	"keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"visual_asset_id" uuid,
	"visual_source" text,
	"generation_id" uuid,
	"suggestions" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"status" text DEFAULT 'empty' NOT NULL,
	"job_id" uuid,
	"error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_scenes_run_segment_key" UNIQUE("run_id","segment_id"),
	CONSTRAINT "pipeline_scenes_status_check" CHECK ("pipeline_scenes"."status" in ('empty', 'queued', 'running', 'ready', 'failed')),
	CONSTRAINT "pipeline_scenes_visual_source_check" CHECK ("pipeline_scenes"."visual_source" is null or "pipeline_scenes"."visual_source" in ('library', 'generated', 'manual'))
);
--> statement-breakpoint
ALTER TABLE "voice_lines" DROP CONSTRAINT "voice_lines_text_origin_check";--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_scenes" ADD CONSTRAINT "pipeline_scenes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_scenes" ADD CONSTRAINT "pipeline_scenes_run_id_pipeline_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_scenes" ADD CONSTRAINT "pipeline_scenes_visual_asset_id_assets_id_fk" FOREIGN KEY ("visual_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_scenes" ADD CONSTRAINT "pipeline_scenes_generation_id_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."generations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_scenes" ADD CONSTRAINT "pipeline_scenes_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pipeline_scenes_run_position_idx" ON "pipeline_scenes" USING btree ("run_id","position");--> statement-breakpoint
ALTER TABLE "voice_lines" ADD CONSTRAINT "voice_lines_text_origin_check" CHECK ("voice_lines"."text_origin" in ('manual', 'stt', 'translated', 'script'));