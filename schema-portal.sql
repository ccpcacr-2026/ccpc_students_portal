-- ═══════════════════════════════════════════════════════
-- CCPC Student Portal — Supabase Schema
-- Run in Supabase SQL editor (same project as admission portal)
-- ═══════════════════════════════════════════════════════

-- ── Tab configurations (replaces Google Sheet "tabs") ──────────────────────
CREATE TABLE IF NOT EXISTS portal_tabs (
  id              bigserial PRIMARY KEY,
  tab_name        text UNIQUE NOT NULL,
  fields_json     text        NOT NULL DEFAULT '[]',
  is_enabled      boolean     NOT NULL DEFAULT true,
  condition_json  text        NOT NULL DEFAULT '{}',
  icon_class      text        NOT NULL DEFAULT 'bi-folder-fill',
  default_editable text       NOT NULL DEFAULT 'YES',
  include_fields_json text    NOT NULL DEFAULT '[]',
  sort_order      int         NOT NULL DEFAULT 0
);
ALTER TABLE portal_tabs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "portal_tabs_all" ON portal_tabs;
CREATE POLICY "portal_tabs_all" ON portal_tabs FOR ALL USING (true);

-- ── Student form submissions (replaces individual Google Sheets) ────────────
CREATE TABLE IF NOT EXISTS portal_submissions (
  id           bigserial PRIMARY KEY,
  student_id   text        NOT NULL,
  tab_name     text        NOT NULL,
  data         jsonb       NOT NULL DEFAULT '{}',
  editable     text        NOT NULL DEFAULT 'YES',
  submitted_at timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (student_id, tab_name)
);
CREATE INDEX IF NOT EXISTS portal_sub_student ON portal_submissions (student_id);
CREATE INDEX IF NOT EXISTS portal_sub_tab     ON portal_submissions (tab_name);
ALTER TABLE portal_submissions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "portal_sub_all" ON portal_submissions;
CREATE POLICY "portal_sub_all" ON portal_submissions FOR ALL USING (true);

-- ── Portal settings key-value store ────────────────────────────────────────
-- Keys: bus_registry, place_registry, gp_credentials
CREATE TABLE IF NOT EXISTS portal_settings (
  key        text PRIMARY KEY,
  value      jsonb       NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE portal_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "portal_settings_all" ON portal_settings;
CREATE POLICY "portal_settings_all" ON portal_settings FOR ALL USING (true);

-- ── Bus tracker live-viewer presence ────────────────────────────────────────
-- One row per browser tab currently viewing the live map (student or teacher
-- portal, shared count across both) — refreshed on every ~30s poll from a
-- sessionStorage-persisted id, and pruned of anything not refreshed in the
-- last 90s server-side on each read. No cron needed: get_bus_data does its
-- own upsert-self + delete-stale + count every time it's called.
CREATE TABLE IF NOT EXISTS bus_tracker_presence (
  tracker_id   text PRIMARY KEY,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE bus_tracker_presence ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "bus_tracker_presence_all" ON bus_tracker_presence;
CREATE POLICY "bus_tracker_presence_all" ON bus_tracker_presence FOR ALL USING (true);

-- ── Teacher directory ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS portal_teachers (
  id         bigserial PRIMARY KEY,
  name       text NOT NULL,
  short_name text,
  photo      text,
  mobile     text,
  email      text,
  schedule   jsonb NOT NULL DEFAULT '[]'
);
ALTER TABLE portal_teachers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "portal_teachers_all" ON portal_teachers;
CREATE POLICY "portal_teachers_all" ON portal_teachers FOR ALL USING (true);

-- ── Class routines ──────────────────────────────────────────────────────────
-- routine JSON: { "1st": {"subject":"Math","teacher":"Mr X"}, ... }
CREATE TABLE IF NOT EXISTS portal_routines (
  id         bigserial PRIMARY KEY,
  class_name text NOT NULL,
  section    text,
  day        text,
  routine    jsonb NOT NULL DEFAULT '{}',
  UNIQUE (class_name, section, day)
);
ALTER TABLE portal_routines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "portal_routines_all" ON portal_routines;
CREATE POLICY "portal_routines_all" ON portal_routines FOR ALL USING (true);

-- ── Attendance records ──────────────────────────────────────────────────────
-- Populated by the NFC attendance hardware
CREATE TABLE IF NOT EXISTS attendance_records (
  id              bigserial PRIMARY KEY,
  student_id      text        NOT NULL,
  date            date        NOT NULL,
  entry_time      time,
  exit_time       time,
  entry_device_id text,
  exit_device_id  text,
  UNIQUE (student_id, date)
);
CREATE INDEX IF NOT EXISTS att_student ON attendance_records (student_id);
ALTER TABLE attendance_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "att_all" ON attendance_records;
CREATE POLICY "att_all" ON attendance_records FOR ALL USING (true);

-- ── Pending submissions queue (reused from admission schema) ────────────────
CREATE TABLE IF NOT EXISTS pending_submissions (
  id          bigserial PRIMARY KEY,
  student_id  text        NOT NULL,
  tab_name    text        NOT NULL DEFAULT 'info',
  payload     jsonb       NOT NULL,
  status      text        NOT NULL DEFAULT 'pending',
  error_msg   text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pending_sub_status ON pending_submissions (status, created_at);
ALTER TABLE pending_submissions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pending_anon_insert" ON pending_submissions;
DROP POLICY IF EXISTS "pending_service_all"  ON pending_submissions;
CREATE POLICY "pending_anon_insert" ON pending_submissions FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "pending_service_all" ON pending_submissions FOR ALL USING (true);
