-- Group Forms — team sign-up (e.g. Science Fair) for the student portal.
-- Run in the Supabase SQL editor (same project as the rest of the portal).
--
-- Every object below is explicitly qualified with `student.` — schema-portal.sql's
-- existing tables (portal_tabs, portal_submissions, …) are bare `CREATE TABLE`
-- statements that only land in the `student` schema because whoever first ran
-- that file had a search_path starting with `student`. Confirmed live: there is
-- a stray, empty `public.portal_tabs` table left over from some earlier session
-- that ran the same bare SQL with a plain search_path — completely invisible to
-- the app, which always sends `Accept-Profile: student`. Qualifying every name
-- here removes that risk entirely, independent of whoever's session runs this.

CREATE SCHEMA IF NOT EXISTS student; -- already exists in production; harmless if run elsewhere

-- ── Group Forms (the admin-built template, e.g. "Science Fair 2026") ────────
CREATE TABLE IF NOT EXISTS student.group_forms (
  id                bigserial PRIMARY KEY,
  title             text        NOT NULL,
  description       text,
  icon_class        text        NOT NULL DEFAULT 'bi-people-fill',
  max_team_size     int         NOT NULL DEFAULT 4,      -- includes the leader
  members_required  boolean     NOT NULL DEFAULT false,  -- true = a team must reach max_team_size to count as "complete"
  fields_json       text        NOT NULL DEFAULT '[]',   -- same shape as portal_tabs.fields_json — group-level fields, filled once by the leader
  eligibility_json  text        NOT NULL DEFAULT '{}',   -- who a leader may invite, relative to the leader — see checkGroupEligibility() in route.js for the shape
  is_enabled        boolean     NOT NULL DEFAULT true,   -- hides from every student's nav entirely (mirrors portal_tabs.is_enabled)
  accepting_new     boolean     NOT NULL DEFAULT true,   -- false = no NEW teams can be created; existing teams keep working
  sort_order        int         NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE student.group_forms ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "group_forms_all" ON student.group_forms;
CREATE POLICY "group_forms_all" ON student.group_forms FOR ALL USING (true);

-- ── Teams (the student-built roster inside one Group Form) ──────────────────
CREATE TABLE IF NOT EXISTS student.group_form_teams (
  id                 bigserial PRIMARY KEY,
  group_form_id      bigint      NOT NULL,
  leader_student_id  text        NOT NULL,
  group_data         jsonb       NOT NULL DEFAULT '{}', -- answers to fields_json, entered by the leader only
  status             text        NOT NULL DEFAULT 'active', -- 'active' | 'disbanded'
  is_locked          boolean     NOT NULL DEFAULT false, -- admin per-team freeze — read-only to the leader and members
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS group_form_teams_form_idx ON student.group_form_teams (group_form_id);
ALTER TABLE student.group_form_teams ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "group_form_teams_all" ON student.group_form_teams;
CREATE POLICY "group_form_teams_all" ON student.group_form_teams FOR ALL USING (true);

-- ── Team members (the accepted roster) ───────────────────────────────────────
-- group_form_id is denormalized here on purpose: it is what lets Postgres
-- itself enforce "a student may be an accepted member of only ONE team per
-- Group Form" with a plain UNIQUE constraint, instead of an app-level
-- check-then-insert that a fast double-click could race past.
CREATE TABLE IF NOT EXISTS student.group_form_team_members (
  id             bigserial PRIMARY KEY,
  group_form_id  bigint      NOT NULL,
  team_id        bigint      NOT NULL,
  student_id     text        NOT NULL,
  role           text        NOT NULL DEFAULT 'member', -- 'leader' | 'member'
  joined_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_form_id, student_id)
);
CREATE INDEX IF NOT EXISTS group_form_team_members_team_idx ON student.group_form_team_members (team_id);
ALTER TABLE student.group_form_team_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "group_form_team_members_all" ON student.group_form_team_members;
CREATE POLICY "group_form_team_members_all" ON student.group_form_team_members FOR ALL USING (true);

-- ── Invitations (pending until the invited student logs in and responds) ────
CREATE TABLE IF NOT EXISTS student.group_form_team_invites (
  id                  bigserial PRIMARY KEY,
  group_form_id       bigint      NOT NULL,
  team_id             bigint      NOT NULL,
  invited_by          text        NOT NULL, -- leader's student_id
  invited_student_id  text        NOT NULL,
  status              text        NOT NULL DEFAULT 'pending', -- 'pending' | 'accepted' | 'declined' | 'cancelled'
  created_at          timestamptz NOT NULL DEFAULT now(),
  responded_at        timestamptz,
  UNIQUE (team_id, invited_student_id)
);
CREATE INDEX IF NOT EXISTS group_form_team_invites_student_idx ON student.group_form_team_invites (invited_student_id, status);
ALTER TABLE student.group_form_team_invites ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "group_form_team_invites_all" ON student.group_form_team_invites;
CREATE POLICY "group_form_team_invites_all" ON student.group_form_team_invites FOR ALL USING (true);

-- ── RPC: create a team + the leader's own membership row, atomically ────────
-- Called as POST rest/v1/rpc/group_team_create with Content-Profile: student.
-- If the leader already has an active team for this Group Form, the member
-- insert below hits the UNIQUE(group_form_id, student_id) constraint; the
-- exception raised here aborts the WHOLE function call as one transaction,
-- so the team row inserted a moment earlier is rolled back too — there is
-- no path that leaves an orphan, member-less team behind.
CREATE OR REPLACE FUNCTION student.group_team_create(
  p_group_form_id bigint,
  p_leader_id     text,
  p_group_data    jsonb
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = student, pg_temp
AS $$
DECLARE
  v_team_id bigint;
BEGIN
  INSERT INTO student.group_form_teams (group_form_id, leader_student_id, group_data)
  VALUES (p_group_form_id, p_leader_id, COALESCE(p_group_data, '{}'::jsonb))
  RETURNING id INTO v_team_id;

  BEGIN
    INSERT INTO student.group_form_team_members (group_form_id, team_id, student_id, role)
    VALUES (p_group_form_id, v_team_id, p_leader_id, 'leader');
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'ALREADY_IN_TEAM';
  END;

  RETURN v_team_id;
END;
$$;

-- ── RPC: accept an invite, atomically ────────────────────────────────────────
-- Called as POST rest/v1/rpc/group_team_accept_invite with Content-Profile:
-- student. Re-validates everything at the moment of acceptance (the invite
-- may be stale by the time the student gets to it), inserts the membership
-- row, marks this invite accepted, and — in the same transaction — cancels
-- every OTHER pending invite to this same student for the SAME Group Form,
-- since accepting one settles which team they're on for that event.
CREATE OR REPLACE FUNCTION student.group_team_accept_invite(
  p_invite_id  bigint,
  p_student_id text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = student, pg_temp
AS $$
DECLARE
  v_invite group_form_team_invites%ROWTYPE;
  v_team   group_form_teams%ROWTYPE;
  v_form   group_forms%ROWTYPE;
  v_count  int;
BEGIN
  SELECT * INTO v_invite FROM student.group_form_team_invites WHERE id = p_invite_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INVITE_NOT_FOUND'; END IF;
  IF v_invite.invited_student_id <> p_student_id THEN RAISE EXCEPTION 'NOT_YOUR_INVITE'; END IF;
  IF v_invite.status <> 'pending' THEN RAISE EXCEPTION 'INVITE_NOT_PENDING'; END IF;

  SELECT * INTO v_team FROM student.group_form_teams WHERE id = v_invite.team_id FOR UPDATE;
  IF NOT FOUND OR v_team.status <> 'active' THEN RAISE EXCEPTION 'TEAM_NOT_ACTIVE'; END IF;
  IF v_team.is_locked THEN RAISE EXCEPTION 'TEAM_LOCKED'; END IF;

  SELECT * INTO v_form FROM student.group_forms WHERE id = v_team.group_form_id;
  SELECT count(*) INTO v_count FROM student.group_form_team_members WHERE team_id = v_team.id;
  IF v_count >= v_form.max_team_size THEN RAISE EXCEPTION 'TEAM_FULL'; END IF;

  BEGIN
    INSERT INTO student.group_form_team_members (group_form_id, team_id, student_id, role)
    VALUES (v_invite.group_form_id, v_team.id, p_student_id, 'member');
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'ALREADY_IN_TEAM';
  END;

  UPDATE student.group_form_team_invites
     SET status = 'accepted', responded_at = now()
   WHERE id = p_invite_id;

  UPDATE student.group_form_team_invites
     SET status = 'cancelled', responded_at = now()
   WHERE invited_student_id = p_student_id
     AND group_form_id = v_invite.group_form_id
     AND status = 'pending'
     AND id <> p_invite_id;
END;
$$;

-- ── Grants ────────────────────────────────────────────────────────────────
-- The `student` schema's other tables (portal_tabs, students_data, …) are
-- readable/writable by service_role today, but that grant was evidently set
-- up by hand at some point rather than via a schema-wide default-privilege
-- rule — a brand new table created here does NOT inherit it automatically.
-- Confirmed live: right after this migration first ran, every one of the
-- four tables above returned 403 "permission denied" to the service key
-- (PostgREST error 42501) until these grants were added. Both apps
-- (ccpc-students and ccpc-teachers) hit the same tables with the same
-- service-role key, so one grant here covers both.
GRANT ALL ON student.group_forms, student.group_form_teams, student.group_form_team_members, student.group_form_team_invites
  TO anon, authenticated, service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA student TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION student.group_team_create(bigint, text, jsonb) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION student.group_team_accept_invite(bigint, text) TO anon, authenticated, service_role;

-- ── Tab-level visibility rules ("Logic Rules") ───────────────────────────────
-- Group Forms had no equivalent of portal_tabs.condition_json — the nav entry
-- was shown to EVERY student once is_enabled was on, with no way to restrict
-- it to e.g. "class = Ten" the way an ordinary Tab can. Same shape, same
-- evalRule() evaluator, reused as-is from route.js's get_tabs.
ALTER TABLE student.group_forms ADD COLUMN IF NOT EXISTS condition_json text NOT NULL DEFAULT '{}';

-- ── Rich fill-up page content ────────────────────────────────────────────────
-- `title` stays the short name used in nav/admin lists; these are the
-- separate, optional banner content shown at the TOP of the fill-up page
-- itself (header defaults to title client-side when blank). `description`
-- is reused as-is for the instructions/details block — no new column
-- needed there, just a relabeled UI. cover_photo_url is set by uploading
-- through the new upload_group_form_cover action (both apps), which
-- returns a public URL to store here — same "students" storage bucket
-- the profile-photo uploader already uses, just a differently-prefixed
-- filename, so no new bucket to create.
ALTER TABLE student.group_forms ADD COLUMN IF NOT EXISTS header text;
ALTER TABLE student.group_forms ADD COLUMN IF NOT EXISTS sub_header text;
ALTER TABLE student.group_forms ADD COLUMN IF NOT EXISTS cover_photo_url text;

-- ── Save vs. Submit ──────────────────────────────────────────────────────────
-- A team's group_data was always live/editable with no final state — the
-- leader could keep "saving" team details indefinitely with no equivalent of
-- an ordinary form's one-time Submit. is_submitted marks that a leader has
-- explicitly finalized the team (submit_group_team, route.js) once every
-- invite has been answered (no pending ones left), the team is full if the
-- form requires it, and every member has a profile picture on file. Once
-- set, the team is frozen the same way admin-set is_locked already freezes
-- one — no more inviting, leaving, disbanding or editing group_data — so
-- the admin's roster can tell a finished submission apart from a
-- still-being-assembled draft.
ALTER TABLE student.group_form_teams ADD COLUMN IF NOT EXISTS is_submitted boolean NOT NULL DEFAULT false;
ALTER TABLE student.group_form_teams ADD COLUMN IF NOT EXISTS submitted_at timestamptz;

-- ── Reviewer routing rules (ccpc-teachers only) ──────────────────────────────
-- Lets the admin route each Group Form's submissions to specific teachers for
-- review, WITHOUT giving them the full admin CRUD — and lets different slices
-- of one form's submissions go to different reviewers (e.g. each class's
-- teams reviewed by that class's own class teacher). One row = one routing
-- rule: "teams where <dimension> = <value>" are visible to either whoever is
-- currently the class teacher of that class (assign_mode='class_teacher',
-- resolved live against student.class_teacher_assignments — stays correct if
-- that assignment changes later) or one specific teacher account
-- (assign_mode='user', teacher_user_id = that account's app_users.user_id).
-- `dimension` is 'class' | 'house' | 'group' (the eligibility band name) |
-- 'answer:<data_key>' (one of this form's own fields_json answers, e.g. a
-- Category dropdown) — resolved against the team's leader profile for the
-- first three, or team.group_data for the last.
CREATE TABLE IF NOT EXISTS student.group_form_reviewer_rules (
  id                bigserial PRIMARY KEY,
  group_form_id     bigint      NOT NULL,
  dimension         text        NOT NULL,
  value             text        NOT NULL,
  assign_mode       text        NOT NULL DEFAULT 'user', -- 'class_teacher' | 'user'
  teacher_user_id   text,                                -- set when assign_mode = 'user'
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS group_form_reviewer_rules_form_idx ON student.group_form_reviewer_rules (group_form_id);
CREATE INDEX IF NOT EXISTS group_form_reviewer_rules_teacher_idx ON student.group_form_reviewer_rules (teacher_user_id);
ALTER TABLE student.group_form_reviewer_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "group_form_reviewer_rules_all" ON student.group_form_reviewer_rules;
CREATE POLICY "group_form_reviewer_rules_all" ON student.group_form_reviewer_rules FOR ALL USING (true);
GRANT ALL ON student.group_form_reviewer_rules TO anon, authenticated, service_role;

-- ── "Request Changes" — admin/reviewer sends a submitted team back to the
-- leader for edits, with a comment explaining why. Reuses is_submitted/
-- is_locked exactly as they already work (both false => the team is
-- editable again, same as it was before the leader ever submitted) —
-- these three columns just carry the reviewer's note and a record of who
-- asked and when.
ALTER TABLE student.group_form_teams ADD COLUMN IF NOT EXISTS revision_comment text;
ALTER TABLE student.group_form_teams ADD COLUMN IF NOT EXISTS revision_requested_at timestamptz;
ALTER TABLE student.group_form_teams ADD COLUMN IF NOT EXISTS revision_requested_by text;

-- ── Auto reference numbers for submissions (e.g. "2J2-007") ─────────────────
-- Admin configures, per Group Form, which values become which short codes
-- (group_forms.reference_number_json — same dimension vocabulary the
-- reviewer-rule system already uses: 'house' | 'group' | 'answer:<data_key>'
-- | a bare students_data column name). Assigned once, right after team
-- creation (app/api/portal/route.js's create_group, NOT inside
-- group_team_create itself) via this standalone atomic counter — kept
-- deliberately separate from the team-creation transaction so a bad
-- reference-number config can never break team creation, only this
-- follow-up step.
ALTER TABLE student.group_forms ADD COLUMN IF NOT EXISTS reference_number_json text NOT NULL DEFAULT '{"enabled":false,"parts":[],"seq_digits":3}';
ALTER TABLE student.group_form_teams ADD COLUMN IF NOT EXISTS reference_number text;

CREATE TABLE IF NOT EXISTS student.group_form_counters (
  group_form_id bigint PRIMARY KEY,
  next_seq      int NOT NULL DEFAULT 1
);
ALTER TABLE student.group_form_counters ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "group_form_counters_all" ON student.group_form_counters;
CREATE POLICY "group_form_counters_all" ON student.group_form_counters FOR ALL USING (true);
GRANT ALL ON student.group_form_counters TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION student.group_form_next_seq(p_group_form_id bigint) RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = student, pg_temp
AS $$
DECLARE v_seq int;
BEGIN
  INSERT INTO student.group_form_counters (group_form_id, next_seq) VALUES (p_group_form_id, 2)
  ON CONFLICT (group_form_id) DO UPDATE SET next_seq = student.group_form_counters.next_seq + 1
  RETURNING next_seq - 1 INTO v_seq;
  RETURN v_seq;
END;
$$;
GRANT EXECUTE ON FUNCTION student.group_form_next_seq(bigint) TO anon, authenticated, service_role;

-- ── Reviewer permission tiers + Approve/Reject verdicts ──────────────────────
-- 'admin' reviewers can approve/reject a submission and request changes;
-- 'viewer' reviewers can only look at their slice (read-only — enforced
-- server-side in ccpc-teachers' _isAuthorizedForGroupFormTeam, never just a
-- hidden button). Default 'admin' preserves today's behavior for every rule
-- already saved before this column existed.
ALTER TABLE student.group_form_reviewer_rules ADD COLUMN IF NOT EXISTS permission text NOT NULL DEFAULT 'admin';

-- The reviewer's own verdict — deliberately separate from is_submitted/
-- is_locked/revision_comment (that whole family is about whether the LEADER
-- can still edit the team; this is purely the reviewer's opinion of a
-- submission, re-settable any number of times, never freezes anything).
ALTER TABLE student.group_form_teams ADD COLUMN IF NOT EXISTS review_status text;
ALTER TABLE student.group_form_teams ADD COLUMN IF NOT EXISTS review_status_by text;
ALTER TABLE student.group_form_teams ADD COLUMN IF NOT EXISTS review_status_at timestamptz;

-- revision_requested_by holds a raw identity (a teacher's user_id in
-- ccpc-teachers, or the literal 'admin' in ccpc-students' own shared login) —
-- never fit for display. This carries the human-readable name resolved at the
-- moment the request is made (ccpc-teachers looks it up from
-- teacher_staff.users_profile; ccpc-students just writes 'Admin'), so the
-- student-facing banner always has a name to show without either app needing
-- to resolve the other app's identity system at read time.
ALTER TABLE student.group_form_teams ADD COLUMN IF NOT EXISTS revision_requested_by_name text;
