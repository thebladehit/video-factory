CREATE TABLE "caption_styles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"style" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_language_timelines" (
	"project_id" uuid NOT NULL,
	"language" text NOT NULL,
	"timeline" jsonb NOT NULL,
	"timeline_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_language_timelines_project_id_language_pk" PRIMARY KEY("project_id","language")
);
--> statement-breakpoint
CREATE TABLE "transcripts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"language" text NOT NULL,
	"source" text NOT NULL,
	"text" text NOT NULL,
	"words" jsonb NOT NULL,
	"timing" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transcripts_source_check" CHECK ("transcripts"."source" in ('tts', 'stt')),
	CONSTRAINT "transcripts_timing_check" CHECK ("transcripts"."timing" in ('aligned', 'estimated', 'stt'))
);
--> statement-breakpoint
CREATE TABLE "voice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"segment_id" text NOT NULL,
	"language" text NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"text_origin" text DEFAULT 'manual' NOT NULL,
	"source_hash" text,
	"voice" jsonb,
	"audio_asset_id" uuid,
	"transcript_id" uuid,
	"duration_ms" integer,
	"voiced_hash" text,
	"status" text DEFAULT 'empty' NOT NULL,
	"job_id" uuid,
	"error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voice_lines_project_segment_language_key" UNIQUE("project_id","segment_id","language"),
	CONSTRAINT "voice_lines_text_origin_check" CHECK ("voice_lines"."text_origin" in ('manual', 'stt', 'translated')),
	CONSTRAINT "voice_lines_status_check" CHECK ("voice_lines"."status" in ('empty', 'queued', 'running', 'ready', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "voice" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "renders" ADD COLUMN "subtitles" text;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "voices" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "caption_styles" ADD CONSTRAINT "caption_styles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_language_timelines" ADD CONSTRAINT "project_language_timelines_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_lines" ADD CONSTRAINT "voice_lines_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_lines" ADD CONSTRAINT "voice_lines_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_lines" ADD CONSTRAINT "voice_lines_audio_asset_id_assets_id_fk" FOREIGN KEY ("audio_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_lines" ADD CONSTRAINT "voice_lines_transcript_id_transcripts_id_fk" FOREIGN KEY ("transcript_id") REFERENCES "public"."transcripts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_lines" ADD CONSTRAINT "voice_lines_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "caption_styles_user_idx" ON "caption_styles" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "transcripts_asset_idx" ON "transcripts" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "voice_lines_project_language_idx" ON "voice_lines" USING btree ("project_id","language");