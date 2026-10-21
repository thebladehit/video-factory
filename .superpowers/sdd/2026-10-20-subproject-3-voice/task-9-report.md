# Task 9 report: migration 0005

Implemented schema.ts: tables transcripts, voice_lines, caption_styles, project_language_timelines; columns projects.voice, renders.subtitles, user_settings.voices. Generated drizzle/0005_voice.sql (+ meta); SQL inspected: only CREATE TABLE / ALTER ADD COLUMN / ADD CONSTRAINT FK / CREATE INDEX.

Decisions beyond spec: voice_lines.job_id and transcript_id are FKs (jobs / transcripts, on delete set null); check constraints on text_origin, status, transcripts.source/timing; unique constraint voice_lines_project_segment_language_key; indexes voice_lines(project_id, language), transcripts(asset_id), caption_styles(user_id).

TDD: RED `docker compose run --rm -T api pnpm vt --project db db.int` failed (column "voices" of relation "user_settings" does not exist) before migration. GREEN same command (whole db project): 14/14 passed. pnpm typecheck and pnpm lint green.
Note: vitest project name is `db` (not @vf/db).
