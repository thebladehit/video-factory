CREATE TABLE "publications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"render_id" uuid NOT NULL,
	"language" text NOT NULL,
	"platform" text NOT NULL,
	"account_id" uuid NOT NULL,
	"method" text NOT NULL,
	"status" text NOT NULL,
	"scheduled_at" timestamp with time zone,
	"metadata" jsonb NOT NULL,
	"job_id" uuid,
	"upload_session" text,
	"platform_post_id" text,
	"url" text,
	"error" text,
	"processing_since" timestamp with time zone,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publications_platform_check" CHECK ("publications"."platform" in ('youtube', 'tiktok', 'instagram', 'facebook')),
	CONSTRAINT "publications_method_check" CHECK ("publications"."method" in ('api', 'manual')),
	CONSTRAINT "publications_status_check" CHECK ("publications"."status" in ('scheduled', 'uploading', 'processing', 'published', 'awaiting_manual', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "publish_meta_drafts" (
	"project_id" uuid NOT NULL,
	"language" text NOT NULL,
	"variants" jsonb NOT NULL,
	"model" text NOT NULL,
	"generation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publish_meta_drafts_project_id_language_pk" PRIMARY KEY("project_id","language")
);
--> statement-breakpoint
CREATE TABLE "social_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"method" text NOT NULL,
	"name" text NOT NULL,
	"language" text NOT NULL,
	"external_id" text,
	"profile_url" text,
	"tokens_enc" text,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"token_expires_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "social_accounts_platform_check" CHECK ("social_accounts"."platform" in ('youtube', 'tiktok', 'instagram', 'facebook')),
	CONSTRAINT "social_accounts_method_check" CHECK ("social_accounts"."method" in ('api', 'manual')),
	CONSTRAINT "social_accounts_status_check" CHECK ("social_accounts"."status" in ('active', 'reauth_required'))
);
--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_render_id_renders_id_fk" FOREIGN KEY ("render_id") REFERENCES "public"."renders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_account_id_social_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_meta_drafts" ADD CONSTRAINT "publish_meta_drafts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_meta_drafts" ADD CONSTRAINT "publish_meta_drafts_generation_id_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."generations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "publications_render_account_live_key" ON "publications" USING btree ("render_id","account_id") WHERE "publications"."status" not in ('failed', 'cancelled');--> statement-breakpoint
CREATE INDEX "publications_user_status_idx" ON "publications" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "publications_project_idx" ON "publications" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "social_accounts_external_key" ON "social_accounts" USING btree ("user_id","platform","external_id") WHERE "social_accounts"."external_id" is not null;