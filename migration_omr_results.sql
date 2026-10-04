-- OMR exam results — published, subject-wise results with answer keys,
-- uploaded from the OptiMark Pro desktop scanner's own output files
-- (answer_key.json per Set + result.csv with per-question Q1..Qn columns).
-- Run in the Supabase SQL editor (same project as the rest of the portal).
--
-- Explicitly qualified with `student.` — see migration_group_forms.sql's own
-- header for why (a stray `public.` copy of an identically-named table has
-- happened before in this project from an unqualified CREATE TABLE).

CREATE SCHEMA IF NOT EXISTS student;

-- ── One row per upload (Class + Subject + exam) ─────────────────────────────
-- Answer keys are embedded as JSON rather than a separate table — small
-- (tens of questions), always read together with the batch, and this matches
-- the JSONB-ish text-column convention already used elsewhere in this app
-- (group_data, reference_number_json, ...).
CREATE TABLE IF NOT EXISTS student.omr_exam_batches (
  id                bigserial   PRIMARY KEY,
  class             text        NOT NULL,
  subject           text        NOT NULL,
  exam_title        text        NOT NULL,
  exam_date         date,
  -- {"A": {"1":["A"],"2":["B","C"],...}, "B": {...}} — one entry per Set
  answer_keys_json  text        NOT NULL DEFAULT '{}',
  total_questions   int         NOT NULL DEFAULT 0,
  total_students    int         NOT NULL DEFAULT 0,
  -- Non-fatal warnings carried from scoring time (e.g. "no matching answer
  -- key for set code X") — shown to the admin on the manage screen, never to
  -- students; doesn't block publishing.
  warnings_json     text        NOT NULL DEFAULT '[]',
  is_published      boolean     NOT NULL DEFAULT false,
  published_at      timestamptz,
  created_by        text,        -- teacher_staff.app_users user_id
  created_by_name   text,        -- resolved at upload time (see group_form_teams.revision_requested_by_name for the same pattern/reasoning)
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS omr_exam_batches_class_subject_idx ON student.omr_exam_batches (class, subject);
ALTER TABLE student.omr_exam_batches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "omr_exam_batches_all" ON student.omr_exam_batches;
CREATE POLICY "omr_exam_batches_all" ON student.omr_exam_batches FOR ALL USING (true);

-- ── One row per student per batch ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS student.omr_exam_results (
  id                bigserial   PRIMARY KEY,
  batch_id          bigint      NOT NULL REFERENCES student.omr_exam_batches(id) ON DELETE CASCADE,
  student_id        text        NOT NULL,
  set_code          text,
  marks             int         NOT NULL DEFAULT 0,
  total_questions   int         NOT NULL DEFAULT 0,
  -- {"1": {"marked":["A"],"verdict":"correct"}, "2": {"marked":[],"verdict":"unanswered"}, ...}
  answers_json      text        NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, student_id)
);
CREATE INDEX IF NOT EXISTS omr_exam_results_student_idx ON student.omr_exam_results (student_id);
CREATE INDEX IF NOT EXISTS omr_exam_results_batch_idx ON student.omr_exam_results (batch_id);
ALTER TABLE student.omr_exam_results ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "omr_exam_results_all" ON student.omr_exam_results;
CREATE POLICY "omr_exam_results_all" ON student.omr_exam_results FOR ALL USING (true);

-- ── Publish/unpublish audit trail ────────────────────────────────────────
-- Append-only: [{"action":"published"|"unpublished","by":"<user_id>","by_name":"...","at":"<iso timestamp>"}, ...]
-- "Who uploaded" is already created_by/created_by_name/created_at above —
-- this covers the separate, repeatable publish/unpublish/publish-again
-- history the single is_published flag + published_at can't represent on
-- its own (those two only ever show the CURRENT state's most recent flip).
ALTER TABLE student.omr_exam_batches ADD COLUMN IF NOT EXISTS publish_history_json text NOT NULL DEFAULT '[]';

-- ── Scoring Rule (matches OptiMark Pro's own Settings > Scan Policy >
-- "Scoring Rule" selector: subset/exact/partial) ─────────────────────────
-- A multi-letter key entry (e.g. a question where ["A","B","C","D"] are all
-- marked "correct" in the key) means something different under each rule:
--   subset  (OptiMark Pro's own default) — full credit if every letter the
--           student marked is IN the key, even just one of several listed.
--   exact   — full credit only if the student's marks equal the key exactly.
--   partial — proportional credit (marks fractional, hence the column-type
--           change below) if a strict subset; any mark outside the key is
--           zero credit for that question.
-- Recorded per batch (not a single app-wide setting) since the admin picks
-- it per upload, same as OptiMark Pro's own per-scan-session setting.
ALTER TABLE student.omr_exam_batches ADD COLUMN IF NOT EXISTS scoring_rule text NOT NULL DEFAULT 'subset';
ALTER TABLE student.omr_exam_results ALTER COLUMN marks TYPE numeric;

-- ── GRANT (new custom-schema tables don't inherit this automatically —
-- see the earlier fix for the same issue on the two tables above) ────────
GRANT ALL ON student.omr_exam_batches TO service_role;
GRANT ALL ON student.omr_exam_results TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA student TO service_role;
