import { NextResponse } from 'next/server';

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const ADMIN_ID   = process.env.ADMIN_ID   || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'adminccpcmrm';

// Text columns in students_data sensible as a shared-secret login password —
// which of these are actually accepted is admin-configurable
// (portal_settings.login_password_columns); see the login handler and the
// get/set_login_password_columns actions below. Deliberately excludes
// categorical/shared columns (gender, house, blood, card_status, version,
// shift, session) — many students share the exact same value, so allowing
// those would mean one guessed value unlocks a huge number of accounts, not
// just id/nfc_uid/photo/timestamps/balance-family columns that plainly
// aren't passwords at all.
const LOGIN_PASSWORD_CANDIDATES = ['phone_number', 'father_phone', 'mother_phone', 'fathers_name', 'mothers_name', 'nick_name', 'student_name'];
// Subset of the above compared as digits-only (normPhone); the rest compare
// as a plain case-insensitive trimmed string.
const LOGIN_PHONE_COLUMNS = ['phone_number', 'father_phone', 'mother_phone'];

const GP_PROD_URL  = 'https://bluebird.grameenphone.com/alo-paas';
const GP_STAGE_URL = 'https://bluebird.grameenphone.com/alo-paas-stage';

// Google Sheet with teacher schedule data (legacy GAS project)
const ROUTINE_SHEET_ID = '11l3oc1mpbR8UerpDxCatzuhcBNqkbdNzWzOTiPPdKgk';
const ROUTINE_GID = '842228375';

// Helper: parse schedule CSV exported from the Google Sheet routine tab.
// Format (from GAS code): range E2:M — col 0 = teacher name, cols 1..N = period cells ("class;subject")
function parseSheetSchedule(csv) {
  const scheduleMap = {};
  try {
    const parseLine = (line) => {
      const cols = []; let cur = '', inQ = false;
      for (const ch of line) {
        if (ch === '"') { inQ = !inQ; }
        else if (ch === ',' && !inQ) { cols.push(cur.trim()); cur = ''; }
        else cur += ch;
      }
      cols.push(cur.trim());
      return cols;
    };

    const rows = csv.trim().split('\n').map(parseLine);
    if (rows.length < 2) return scheduleMap;

    // Row 0 = period header row (1st, 2nd, 3rd, 4th/Jr, 4th/Sr, 5th, 6th, 7th)
    // Detect: find the row whose cells look like period labels
    let hIdx = rows.findIndex(r => r.some(c => /^\d+(st|nd|rd|th)/i.test(c) || /^4th\//i.test(c)));
    if (hIdx === -1) hIdx = 0;
    const headers = rows[hIdx];

    // Teacher name column = first column in the range (col before period cols)
    const firstPeriodIdx = headers.findIndex(c => /^\d+(st|nd|rd|th)/i.test(c) || /^4th\//i.test(c));
    const nameCol = firstPeriodIdx > 0 ? firstPeriodIdx - 1 : 0;

    for (let i = hIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      const teacherName = (row[nameCol] || '').trim();
      if (!teacherName) continue;
      if (!scheduleMap[teacherName]) scheduleMap[teacherName] = [];
      for (let j = firstPeriodIdx; j < headers.length; j++) {
        const cell = (row[j] || '').trim();
        if (!cell.includes(';')) continue;
        const [cls, subj] = cell.split(';');
        // Subject may end with "(INITIALS)" — strip that
        const cleanSubj = (subj || cls).replace(/\([^)]+\)$/, '').trim();
        scheduleMap[teacherName].push({ period: headers[j], class: cls.trim(), subject: cleanSubj });
      }
    }
  } catch(_) {}
  return scheduleMap;
}

// The routine sheet identifies teachers by 2-4 letter shortcode (column E of
// the "Selected" tab, e.g. "SKD"), never by full name. The ONLY place that
// code maps back to a real name is the "Logged in info" sheet's "NAME IN
// SHORT" / "Full Name" columns — same cross-reference ccpc-teachers' own
// Routine feature already relies on for the identical reason. Without this,
// scheduleMap ends up keyed by shortcode while callers look it up by
// full_name and every lookup silently misses.
let _shortNameMapCache = null;
async function getShortNameMap() {
  if (_shortNameMapCache) return _shortNameMapCache;
  const map = { byShort: {}, byFull: {} };
  try {
    const res = await fetch(
      `https://docs.google.com/spreadsheets/d/${ROUTINE_SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('Logged in info')}`,
      { signal: AbortSignal.timeout(6000) }
    );
    if (res.ok) {
      const rows = _parseCsv(await res.text());
      const header = rows[0] || [];
      const fnIdx = header.findIndex(h => String(h).trim() === 'Full Name');
      const snIdx = header.findIndex(h => String(h).trim() === 'NAME IN SHORT');
      if (fnIdx >= 0 && snIdx >= 0) {
        for (let i = 1; i < rows.length; i++) {
          const shortname = String(rows[i][snIdx] || '').trim();
          const fullName = String(rows[i][fnIdx] || '').trim();
          if (!shortname || !fullName) continue;
          map.byShort[shortname] = fullName;
          map.byFull[fullName] = shortname;
        }
      }
    }
  } catch (_) { /* resolution is best-effort — falls back to the bare shortcode */ }
  _shortNameMapCache = map;
  return map;
}

// Minimal RFC4180 CSV parser — gviz always quotes every field (same parser
// shape as ccpc-teachers' _fetchSheetRows, so both apps read sheets identically).
function _parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ── Routine sheet helpers (shared by get_class_routine + get_teacher_schedule) ──
// Both actions read one of two tabs on the same sheet: "Selected" (today's
// live/adjusted copy, single day) or "Classes" (the static weekly master,
// every weekday). `weekday` picks which; omitting it means "Selected".
async function _fetchRoutineRows(weekday) {
  if (weekday) {
    const res = await fetch(
      `https://docs.google.com/spreadsheets/d/${ROUTINE_SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('Classes')}`,
      { signal: AbortSignal.timeout(6000) }
    );
    if (!res.ok) return { error: 'Could not read the Classes sheet.' };
    return { rows: _parseCsv(await res.text()), meta: { source: 'classes', weekday } };
  }
  const res = await fetch(
    `https://docs.google.com/spreadsheets/d/${ROUTINE_SHEET_ID}/export?format=csv&gid=${ROUTINE_GID}`,
    { signal: AbortSignal.timeout(6000) }
  );
  if (!res.ok) return { error: 'Could not read the routine sheet.' };
  const rows = _parseCsv(await res.text());
  return { rows, meta: { source: 'selected', date: String((rows[0] || [])[3] || '').trim(), weekday: String((rows[0] || [])[5] || '').trim() } };
}

// Header row = the one containing a "1st"-style period label. "Name" is
// always the column immediately before it in both sheets (true even on
// "Classes", whose gviz export has a leading blank column and a stray "."
// column before that — never assumed positionally, only located by this
// text-based scan, which lands on the same relative offset either way).
function _detectRoutineHeader(rows) {
  const hIdx = rows.findIndex(r => r.some(c => /^\d+(st|nd|rd|th)/i.test(c) || /^4th\//i.test(c)));
  if (hIdx === -1) return null;
  const headers = rows[hIdx];
  const firstPeriodIdx = headers.findIndex(c => /^\d+(st|nd|rd|th)/i.test(c) || /^4th\//i.test(c));
  const nameCol = firstPeriodIdx > 0 ? firstPeriodIdx - 1 : 0;
  return { headers, firstPeriodIdx, nameCol, dataRows: rows.slice(hIdx + 1) };
}

// "Classes" holds every weekday in one sheet — narrow to the requested one.
// No-op for "Selected", which is already just a single day.
function _filterByWeekday(dataRows, headers, weekday) {
  if (!weekday) return dataRows;
  const weekdayIdx = headers.findIndex(h => String(h).trim() === 'Weekday');
  if (weekdayIdx < 0) return dataRows;
  const wantWd = String(weekday).trim().toLowerCase();
  return dataRows.filter(r => String(r[weekdayIdx] || '').trim().toLowerCase() === wantWd);
}

// Almost always "Class;Subject" — one known cell in "Classes" uses a comma
// instead ("IX-D, Biology"), so fall back to it when there's no semicolon
// rather than silently dropping that class+period.
function _splitRoutineCell(cell) {
  const delim = cell.includes(';') ? ';' : (cell.includes(',') ? ',' : null);
  return delim ? cell.split(delim) : null;
}

function _periodKeyFor(headerText) {
  const h = String(headerText || '').toLowerCase();
  if (h.includes('junior')) return '4th/Jr';
  if (h.includes('senior')) return '4th/Sr';
  return headerText;
}

// A trailing "(XX)" on the subject means this cell's row-owner is covering
// for XX today — the row owner is who's ACTUALLY there; XX is who they're
// substituting for. (Verified convention — see ccpc-teachers'
// getTodayRoutineBoard, same sheet, same annotation.)
function _extractAdjustment(rawSubject) {
  const m = rawSubject.match(/\(([^)]+)\)\s*$/);
  if (!m) return { subject: rawSubject, originalShort: null };
  return { subject: rawSubject.replace(/\(([^)]+)\)\s*$/, '').trim(), originalShort: m[1].trim() };
}

// Forum posts/replies can be authored by either a teacher (author_id = a
// plain user_id, resolved against teacher.users_profile) or, now that
// students can post/reply too, a student (author_id = 'student:<id>',
// resolved against this app's own student.students_data). Splits the id
// list by that prefix and resolves each half against its own table.
async function _resolveAuthorNames(authorIds) {
  const nameById = {};
  const studentIds = authorIds.filter(id => id.startsWith('student:')).map(id => id.slice('student:'.length));
  const teacherIds = authorIds.filter(id => !id.startsWith('student:'));
  const [profiles, students] = await Promise.all([
    teacherIds.length ? sb(`users_profile?teacher_id=in.(${teacherIds.map(encodeURIComponent).join(',')})&select=teacher_id,full_name`, 'GET', null, { 'Accept-Profile': 'teacher_staff', 'Content-Profile': 'teacher_staff' }) : [],
    studentIds.length ? sb(`students_data?student_id=in.(${studentIds.map(encodeURIComponent).join(',')})&select=student_id,student_name`) : [],
  ]);
  if (Array.isArray(profiles)) profiles.forEach(p => { nameById[p.teacher_id] = p.full_name; });
  if (Array.isArray(students)) students.forEach(s => { nameById['student:' + s.student_id] = s.student_name; });
  return nameById;
}

async function sb(path, method = 'GET', body = null, extra = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: method === 'POST' ? 'return=representation' : 'return=minimal',
      'Accept-Profile': 'student',
      'Content-Profile': 'student',
      ...extra,
    },
    ...(body !== null ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) return { error: text };
  return text ? JSON.parse(text) : [];
}

// PostgREST silently caps ANY select at this project's configured max_rows
// (3000) with no explicit Range header and no guaranteed row order — a
// plain sb() call against a school-wide, unfiltered table (e.g. every
// attendance_records row ever written) only ever returns an arbitrary 3000
// of them. Paginates with Range instead of trusting one request.
async function sbAllRows(path) {
  const PAGE = 3000;
  let all = [];
  let offset = 0;
  while (true) {
    const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Accept-Profile': 'student', Range: `${offset}-${offset + PAGE - 1}` },
    });
    if (!res.ok) return { error: await res.text() };
    const page = await res.json();
    if (!Array.isArray(page)) return { error: 'Unexpected response shape' };
    all = all.concat(page);
    if (page.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

function normPhone(p) { return String(p || '').replace(/\D/g, '').slice(-10); }
function normKey(s)   { return String(s || '').toLowerCase().replace(/[\s_]/g, ''); }

// ── Bus tracker live-viewer presence ─────────────────────────────────────
// One row per browser tab currently viewing the live map (shared count
// across the student and teacher portals — same bus_tracker_presence table,
// same 'student' schema as portal_settings). No cron: every get_bus_data
// call upserts its own heartbeat, prunes anything not refreshed in 90s
// (the real client poll is every 8s — public/js/bus-tracking.js's
// busUpdateInterval — so 90s is a generous margin, not literally 3x
// anything; a stale comment here used to claim a 30s poll), and counts
// what's left. Never lets a presence hiccup break the bus data itself.
// `label` is a client-supplied display string stored alongside the
// heartbeat purely so an Admin (in ccpc-teachers' Bus Tracker) can see WHO
// is watching, not just a count — this app itself has no UI for the list,
// only ccpc-teachers does; this side just needs to keep contributing a
// readable label into the shared table.
//
// The self-upsert and the stale-prune are independent of each other —
// run them together instead of one-after-another (this endpoint gets
// polled every 8s per open tab, so shaving round-trips here matters).
async function _trackPresence(trackerId, label) {
  if (!trackerId || typeof trackerId !== 'string') return { count: 0, watchers: [] };
  try {
    const id = trackerId.slice(0, 64);
    const nowIso = new Date().toISOString();
    const cutoffIso = new Date(Date.now() - 90000).toISOString();
    await Promise.all([
      sb('bus_tracker_presence?on_conflict=tracker_id', 'POST',
        { tracker_id: id, last_seen_at: nowIso, label: String(label || '').slice(0, 120) || null },
        { Prefer: 'resolution=merge-duplicates,return=minimal' }),
      sb(`bus_tracker_presence?last_seen_at=lt.${encodeURIComponent(cutoffIso)}`, 'DELETE'),
    ]);
    const live = await sb('bus_tracker_presence?select=tracker_id,label,last_seen_at&order=last_seen_at.desc');
    const rows = Array.isArray(live) ? live : [];
    return { count: rows.length, watchers: rows.map(r => ({ label: r.label || 'Viewer', lastSeen: r.last_seen_at })) };
  } catch (_) {
    return { count: 0, watchers: [] };
  }
}

// Short-lived cache for the GP bus-location fetch (which is itself a token
// request + a location request — two outbound calls to Grameenphone's API
// per miss). Many concurrent viewers polling within the same few seconds
// would otherwise each trigger their own identical upstream fetch; this
// collapses them into one. Best-effort module-level state only (resets on
// a cold start) — a miss just means one fresh fetch, never a failure, and
// an 8s TTL means a single steady viewer still gets fresh-enough data on
// nearly every one of their own 8s polls while concurrent viewers share it.
let _busDataCache = { key: '', data: null, expiresAt: 0 };
async function _getCachedBusLocations(creds, imeiList) {
  const key = (creds.api_key || '') + '|' + imeiList.join(',');
  const now = Date.now();
  if (_busDataCache.key === key && _busDataCache.expiresAt > now) return _busDataCache.data;
  const items = await queryGPLocations(creds, imeiList);
  _busDataCache = { key, data: items, expiresAt: now + 8000 };
  return items;
}

// Shared by the login handler and reset_pin (the "Forgot PIN?" flow uses the
// exact same admin-selected-column verification to prove identity before
// clearing a PIN). Phone-like columns match on digits only; the rest match
// on a plain case-insensitive trim.
async function verifyAdminSelectedPassword(studentData, inputValue) {
  const cfgRows = await sb('portal_settings?key=eq.login_password_columns');
  const cfgSaved = (!cfgRows?.error && cfgRows[0]) ? cfgRows[0].value : null;
  const passwordColumns = Array.isArray(cfgSaved) ? cfgSaved.filter(c => LOGIN_PASSWORD_CANDIDATES.includes(c)) : LOGIN_PASSWORD_CANDIDATES;

  const allowedPhone = [];
  const allowedText = [];
  passwordColumns.forEach((k) => {
    const v = studentData[k];
    if (!v) return;
    if (LOGIN_PHONE_COLUMNS.includes(k)) {
      const n = normPhone(v);
      if (n && !allowedPhone.includes(n)) allowedPhone.push(n);
    } else {
      const n = String(v).trim().toLowerCase();
      if (n && !allowedText.includes(n)) allowedText.push(n);
    }
  });
  const inputPhone = normPhone(inputValue);
  const inputText = String(inputValue || '').trim().toLowerCase();
  return {
    anyAllowed: allowedPhone.length > 0 || allowedText.length > 0,
    matches: allowedPhone.includes(inputPhone) || allowedText.includes(inputText),
  };
}

// Assigned via ccpc-teachers' own "Assign Class Teacher" admin panel
// (student.class_teacher_assignments) — this looks up that assignment and
// resolves the teacher's display name from the teacher schema, same
// cross-schema pattern get_teacher_directory uses. Called on every login so
// a newly-made assignment shows up immediately, with no caching to go stale.
//
// A class+section can have several assignment rows at once, each narrowed
// by its own extra_criteria — an arbitrary {column:value} object (e.g.
// {"group":"Science"} or {"shift":"Morning","version":"English"}, or {}
// for a class-wide assignment with no further narrowing) picked freely by
// the admin per combination, not a fixed set of columns. A combination can
// only ever belong to one teacher, so at most one row can fully match this
// student's own data at each level of specificity — prefer whichever
// matching row has the MOST criteria keys (most specific), falling back to
// a class-wide ({}) row if nothing more specific matches.
async function _getClassTeacherName(cls, section, studentRow) {
  if (!cls || !section) return null;
  const rows = await sb(
    `class_teacher_assignments?class=eq.${encodeURIComponent(cls)}&section=eq.${encodeURIComponent(section)}&select=user_id,extra_criteria`
  );
  if (rows?.error || !Array.isArray(rows) || !rows.length) return null;
  // Same "blank -> None" normalization get_class_sections applies when it
  // originally offered these columns to the admin, so a student with an
  // actually-empty column matches a combo saved with that column = "None".
  const normVal = (v) => (String(v || '').trim() || 'None').toLowerCase();
  const matches = rows.filter(r => {
    const ec = r.extra_criteria || {};
    return Object.entries(ec).every(([col, val]) => normVal(studentRow[col]) === normVal(val));
  });
  if (!matches.length) return null;
  matches.sort((a, b) => Object.keys(b.extra_criteria || {}).length - Object.keys(a.extra_criteria || {}).length);
  const userId = matches[0].user_id;
  if (!userId) return null;
  const profRows = await sb(
    `users_profile?teacher_id=eq.${encodeURIComponent(userId)}&select=full_name`,
    'GET', null,
    { 'Accept-Profile': 'teacher_staff', 'Content-Profile': 'teacher_staff' }
  );
  return (!profRows?.error && profRows[0] && profRows[0].full_name) ? profRows[0].full_name : null;
}

// ── Evaluate tab condition rule ──────────────────────────────────────────────
async function evalRule(rule, profile, submissions) {
  const profileKeys = Object.keys(profile);
  const targetKey = profileKeys.find(k => normKey(k) === normKey(rule.column));
  const val = String(profile[targetKey || rule.column] || '').toLowerCase();
  const target = String(rule.value || '').toLowerCase();
  const targets = target.split(',').map(s => s.trim());

  switch (rule.operator) {
    case 'eq':       return targets.includes(val);
    case 'neq':      return !targets.includes(val);
    case 'contains': return targets.some(t => val.includes(t));
    case 'in_sheet': {
      const sid = profile.student_id;
      return submissions.some(s => s.student_id === sid && s.tab_name === rule.value);
    }
    case 'not_in_sheet': {
      const sid = profile.student_id;
      return !submissions.some(s => s.student_id === sid && s.tab_name === rule.value);
    }
    default: return true;
  }
}

// Group Forms' two RPCs (group_team_create / group_team_accept_invite) raise a
// short, specific code as their exception message when a business rule blocks
// the request — sb() only ever returns the raw response body text on error
// (never a parsed object), so this pulls the Postgres message back out of that
// text and turns a known code into something worth showing a student.
const GROUP_RPC_ERRORS = {
  ALREADY_IN_TEAM: 'You are already in a team for this form — leave it first if you want to join another.',
  TEAM_FULL: 'This team is already full.',
  TEAM_LOCKED: 'This team has been locked by the admin.',
  TEAM_NOT_ACTIVE: 'This team no longer exists.',
  INVITE_NOT_PENDING: 'This invite has already been answered.',
  INVITE_NOT_FOUND: 'Invite not found.',
  NOT_YOUR_INVITE: 'This is not your invite.',
};
function rpcErrorMessage(rawError) {
  let msg = rawError;
  try { msg = JSON.parse(rawError)?.message || rawError; } catch (_) {}
  return GROUP_RPC_ERRORS[msg] || msg || 'Something went wrong.';
}

// A Group Form's eligibility_json says who a leader may invite, RELATIVE TO
// THE LEADER — never an absolute list of allowed classes/houses, since the
// rule is meant to travel with whoever leads (a class-6 student's team stays
// within class 6, a class-9 student's team stays within class 9, with no
// separate rule needed per class). Shape:
//   { class_mode: 'none'|'exact'|'band', bands: [[cls,cls,…], …], same_section: bool, same_house: bool }
// class_mode 'band' groups several classes into one eligible unit (e.g.
// Six/Seven/Eight banded together) — the invited student's class only has to
// fall in the SAME band as the leader's, not match it exactly; which band
// applies is worked out automatically from where each class sits in the
// admin's band list, never chosen by hand per invite.
// Every Group Form participant — the leader creating a team, and any
// teammate accepting an invite into one — must have a profile picture on
// file first, so a team is never made up of unidentifiable students. This
// is a hard rule enforced here (create_group / respond_to_invite), not an
// opt-in the admin has to remember to add via a "Profile Picture" field.
async function hasProfilePhoto(studentId) {
  const rows = await sb(`students_data?student_id=eq.${encodeURIComponent(studentId)}&select=photo`);
  const photo = (!rows?.error && rows[0]) ? rows[0].photo : null;
  return !!(photo && String(photo).trim());
}

// After an invite is accepted (by the student themselves, or on their
// behalf via the admin-side's identical RPC) the team may already meet
// every requirement submit_group_team itself checks — rather than leave
// the leader to remember a separate manual Submit, finish the job right
// here. Mirrors submit_group_team's own gating exactly (pending invites,
// members_required, every member's photo) and silently no-ops if anything
// isn't actually ready — this is a convenience, never a requirement, so a
// caller never needs to check its result or handle a failure from it.
async function _maybeAutoSubmitTeam(team_id) {
  const teamRows = await sb(`group_form_teams?id=eq.${encodeURIComponent(team_id)}`);
  const team = (!teamRows?.error && teamRows[0]) ? teamRows[0] : null;
  if (!team || team.status !== 'active' || team.is_locked || team.is_submitted) return;

  const [formRows, memberRows, pendingRows] = await Promise.all([
    sb(`group_forms?id=eq.${encodeURIComponent(team.group_form_id)}`),
    sb(`group_form_team_members?team_id=eq.${encodeURIComponent(team_id)}`),
    sb(`group_form_team_invites?team_id=eq.${encodeURIComponent(team_id)}&status=eq.pending`),
  ]);
  const form = (!formRows?.error && formRows[0]) ? formRows[0] : null;
  if (!form) return;
  const members = Array.isArray(memberRows) ? memberRows : [];
  const pending = Array.isArray(pendingRows) ? pendingRows : [];
  if (pending.length) return;
  if (form.members_required && members.length < form.max_team_size) return;
  if (missingRequiredFields(form.fields_json, team.group_data).length) return;

  const photoChecks = await Promise.all(members.map(m => hasProfilePhoto(m.student_id)));
  if (photoChecks.some(ok => !ok)) return;

  await sb(`group_form_teams?id=eq.${encodeURIComponent(team_id)}`, 'PATCH', {
    is_submitted: true, submitted_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    revision_comment: null, revision_requested_at: null, revision_requested_by: null, revision_requested_by_name: null,
  });
}

// Server-side mirror of the client's matchShowIfData/_gfMissingRequiredFields
// — a field the admin marked Mandatory (fields_json[].required) but that's
// hidden by its own show_if is never actually required, matching exactly
// what the leader sees. Used both to reject a premature submit_group_team
// with a specific message, and to gate auto-submit the same way pending
// invites/members_required/photos already do. data's checkbox values are
// always the same comma-joined string every submit path already stores, so
// one plain "is it blank" check covers every field type uniformly.
function missingRequiredFields(fieldsJsonStr, data) {
  let fields = [];
  try { fields = JSON.parse(fieldsJsonStr || '[]'); } catch (_) {}
  const d = data || {};
  const lookup = key => d[key];
  const matchSingle = (cond, val) => {
    const cur = String(val == null ? '' : val).toLowerCase().trim();
    const targets = Array.isArray(cond.value) ? cond.value : Array.isArray(cond.values) ? cond.values : [cond.value];
    return targets.some(t => String(t == null ? '' : t).toLowerCase().trim() === cur);
  };
  const matchShowIf = showIf => {
    if (!showIf) return true;
    let result;
    if (Array.isArray(showIf.all)) result = showIf.all.every(c => matchSingle(c, lookup(c.field)));
    else if (Array.isArray(showIf.any)) result = showIf.any.some(c => matchSingle(c, lookup(c.field)));
    else result = matchSingle(showIf, lookup(showIf.field));
    return showIf.negate ? !result : result;
  };
  const missing = [];
  fields.forEach(f => {
    if (!f.required) return;
    if (f.type === 'group_label' || f.type === 'profile_picture' || f.type === 'class_group') return;
    if (f.show_if && !matchShowIf(f.show_if)) return;
    const val = d[f.data_key];
    if (val === undefined || val === null || String(val).trim() === '') missing.push(f.name || f.data_key);
  });
  return missing;
}

function checkGroupEligibility(eligibilityJson, leader, candidate) {
  let elig = {};
  try { elig = JSON.parse(eligibilityJson || '{}') || {}; } catch (_) {}
  // Which students_data column "exact"/"band" match against — defaults to
  // 'class' so eligibility_json saved before this existed keeps working
  // unchanged. Admin picks this from the full header list (get_field_values),
  // not just class/section/house.
  const groupField = elig.group_field || 'class';
  const fieldLabel = groupField.replace(/_/g, ' ');
  if (elig.class_mode === 'exact') {
    if (String(leader[groupField] || '') !== String(candidate[groupField] || '')) {
      return { ok: false, reason: `must have the same ${fieldLabel} as you` };
    }
  } else if (elig.class_mode === 'band') {
    const bands = Array.isArray(elig.bands) ? elig.bands : [];
    // A band is either the current {name, classes} shape or a legacy bare
    // array of class names (eligibility_json saved before bands had names).
    const bandClasses = b => Array.isArray(b) ? b : (Array.isArray(b.classes) ? b.classes : []);
    const bandIndexOf = val => bands.findIndex(b => bandClasses(b).includes(val));
    const li = bandIndexOf(leader[groupField]), ci = bandIndexOf(candidate[groupField]);
    if (li < 0 || li !== ci) return { ok: false, reason: "must be in your team's group" };
  }
  if (elig.same_section && String(leader.section || '') !== String(candidate.section || '')) {
    return { ok: false, reason: 'must be in the same section as you' };
  }
  if (elig.same_house && String(leader.house || '') !== String(candidate.house || '')) {
    return { ok: false, reason: 'must be in the same house as you' };
  }
  return { ok: true };
}

// Which named band (e.g. "Group B (Six-Eight)") a profile's own value at
// eligibility_json.group_field falls into — same band-matching rule
// checkGroupEligibility uses, just returning the band's name instead of a
// pass/fail. Used by the reference-number builder below (dimension 'group').
function resolveGroupBandName(eligibilityJson, profile) {
  let elig = {};
  try { elig = JSON.parse(eligibilityJson || '{}') || {}; } catch (_) {}
  if (elig.class_mode !== 'band') return null;
  const groupField = elig.group_field || 'class';
  const bands = Array.isArray(elig.bands) ? elig.bands : [];
  const bandClasses = b => Array.isArray(b) ? b : (Array.isArray(b.classes) ? b.classes : []);
  const bandName = b => Array.isArray(b) ? null : (b.name || null);
  const val = profile ? profile[groupField] : undefined;
  const band = bands.find(b => bandClasses(b).includes(val));
  return band ? bandName(band) : null;
}

// Builds a submission reference number (e.g. "2J2-007") from an admin-
// configured recipe (group_forms.reference_number_json) and assigns the
// next sequence number via a dedicated counter RPC — deliberately NOT part
// of the group_team_create transaction, so a bad reference-number config
// can never break team creation itself, only this follow-up step (a team
// created without one can always have it filled in later).
async function buildReferenceNumber(referenceNumberJson, form, leaderProfile, groupData) {
  let cfg = {};
  try { cfg = JSON.parse(referenceNumberJson || '{}') || {}; } catch (_) {}
  if (!cfg.enabled || !Array.isArray(cfg.parts) || !cfg.parts.length) return null;

  let fields = [];
  try { fields = JSON.parse(form.fields_json || '[]') || []; } catch (_) {}

  let body = '';
  for (const part of cfg.parts) {
    const source = part && part.source;
    const map = (part && part.map) || {};
    let value;
    if (source === 'group') value = resolveGroupBandName(form.eligibility_json, leaderProfile);
    else if (source && source.startsWith('answer:')) {
      const key = source.slice(7);
      value = (groupData || {})[key];
      // This field may be conditionally shown (show_if) — e.g. Science
      // Fair's two differently-keyed "Category" fields, one per eligibility
      // Group, each hidden/shown by show_if. Whichever one the leader
      // actually saw and filled in is the one with a real value in
      // group_data; the other's data_key is simply absent. If the
      // originally-configured field came back empty, fall back to any
      // sibling field sharing its display name that DOES have a value —
      // same idea the admin UI already applies when listing/merging their
      // value options into one combined mapping.
      if ((value === undefined || value === '') && fields.length) {
        const configuredField = fields.find(f => f.data_key === key);
        if (configuredField) {
          const sibling = fields.find(f => f.name === configuredField.name && f.data_key !== key && (groupData || {})[f.data_key] !== undefined && (groupData || {})[f.data_key] !== '');
          if (sibling) value = (groupData || {})[sibling.data_key];
        }
      }
    }
    else if (source) value = leaderProfile ? leaderProfile[source] : undefined; // e.g. 'house', 'class'
    body += (map[value] || '');
  }
  if (!body) return null; // nothing matched — don't hand out a bare sequence number alone

  const seqRes = await sb('rpc/group_form_next_seq', 'POST', { p_group_form_id: form.id });
  if (seqRes?.error || typeof seqRes !== 'number') return null;
  const digits = Number(cfg.seq_digits) || 3;
  return `${body}-${String(seqRes).padStart(digits, '0')}`;
}

// NOTE: set_gp_credentials saves {api_key, environment, channel} (see
// get_tracking_config, which reads those same names back for display) --
// this used to read gp_api_key/gp_env/gp_channel instead, a leftover from
// an earlier naming, so credentials the admin saved were never actually
// found and this always threw "GP API credentials not configured."
async function getGPToken(settings) {
  const apiKey  = settings.api_key;
  const channel = settings.channel  || 'ALOEXT';
  const baseUrl = settings.environment === 'staging' ? GP_STAGE_URL : GP_PROD_URL;
  if (!apiKey) throw new Error('GP API credentials not configured.');

  const r = await fetch(`${baseUrl}/auth/token`, {
    headers: { 'api-key': apiKey, channel },
  });
  const data = await r.json();
  if (data?.data?.token) return { token: data.data.token, baseUrl };
  throw new Error('GP token fetch failed: ' + JSON.stringify(data));
}

// GP's real (documented) location endpoint — POST with a JSON {imei:[...]}
// body, NOT the GET /tracking/latest?imei= this used to call (that path
// doesn't exist at all — 404s). Also needs the api-key header on THIS call
// too, not just on /auth/token. Response fields per GP's docs: latitude/
// longitude (strings), speed, heading, engineStatus (bool), locationTime,
// address — none of which match the ignition/lat/lng/timestamp names this
// used to read, so every result silently came back empty.
async function queryGPLocations(settings, imeiList) {
  const { token, baseUrl } = await getGPToken(settings);
  const r = await fetch(`${baseUrl}/api/v1/vts/location/current-attributes`, {
    method: 'POST',
    headers: {
      'api-key': settings.api_key,
      channel: settings.channel || 'ALOEXT',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ imei: imeiList }),
  });
  const json = await r.json();
  if (!r.ok) throw new Error(`GP location query failed (HTTP ${r.status}): ${JSON.stringify(json)}`);
  return Array.isArray(json?.data) ? json.data : [];
}

// ── Canteen helpers (shared with the ccpc-canteen app on the same tables) ────
const CANTEEN_DEFAULTS = {
  enable_daily_limit: true, enable_monthly_limit: true, enable_lending_limit: true,
  general_daily_limit: 120, general_monthly_limit: 1200, general_lending_limit: 200,
  low_stock_threshold: 10, notify_app_enabled: true,
};
async function canteenSettings() {
  const rows = await sb('canteen_settings?id=eq.1&select=data');
  if (Array.isArray(rows) && rows[0] && rows[0].data) return { ...CANTEEN_DEFAULTS, ...rows[0].data };
  return { ...CANTEEN_DEFAULTS };
}
// Ports the kiosk's get_active_menu_ids(): which food ids are on an active menu now.
function resolveActiveFoodIds(menus, now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const weekday = now.toLocaleDateString('en-US', { weekday: 'long' });
  const dayOfMonth = String(now.getDate());
  const ids = new Set();
  for (const mn of (Array.isArray(menus) ? menus : [])) {
    let active = false;
    const ov = String(mn.override_date || '');
    if (ov.slice(0, 10) === today) active = !!Number(mn.activated);
    else {
      const s = mn.scheduled, d = String(mn.description || '');
      if (s === 'Daily') active = true;
      else if (s === 'Weekly' && d === weekday) active = true;
      else if (s === 'Monthly' && d === dayOfMonth) active = true;
      else if (s === 'Date' && (d === today || d.slice(0, 10) === today)) active = true;
      else if (s === 'Custom') active = !!Number(mn.activated);
    }
    if (active && mn.items) String(mn.items).split(',').forEach((x) => { const t = x.trim(); if (/^\d+$/.test(t)) ids.add(Number(t)); });
  }
  return ids;
}
async function canteenNotify(studentId, message, kind = 'info') {
  try { await sb('canteen_notifications', 'POST', { student_id: studentId, message, kind }); } catch (_) {}
}
async function canteenBestCounter() {
  try {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const counters = await sb(`canteen_counters?status=eq.true&last_seen_at=gt.${fiveMinAgo}&select=counter_id`);
    const active = (Array.isArray(counters) ? counters : []).map((c) => c.counter_id);
    if (!active.length) return 1;
    const counts = await Promise.all(active.map(async (cid) => {
      const r = await sb(`canteen_orders?is_delivered=eq.false&counter_no=eq.${cid}&select=id`);
      return { cid, n: Array.isArray(r) ? r.length : 0 };
    }));
    counts.sort((a, b) => a.n - b.n);
    return counts[0].cid;
  } catch (_) { return 1; }
}
function monthStartISO() { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d.toISOString(); }
function dayStartISO() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString(); }

export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const { action, payload = {} } = body;

  // ── Login-page notices (public, no auth) ────────────────────────────────────
  if (action === 'get_notices') {
    const rows = await sb('portal_notices?is_enabled=eq.true&order=sort_order.asc,id.asc');
    return NextResponse.json((rows && !rows.error) ? rows : []);
  }

  // ── Admin: full notice list, CRUD & reorder ─────────────────────────────────
  if (action === 'get_notices_admin') {
    const rows = await sb('portal_notices?order=sort_order.asc,id.asc');
    return NextResponse.json((rows && !rows.error) ? rows : []);
  }

  if (action === 'save_notice') {
    const { id, title, subtitle, body: noticeBody, is_enabled } = payload;
    const rowData = { title: title || '', subtitle: subtitle || '', body: noticeBody || '', is_enabled: is_enabled !== false, updated_at: new Date().toISOString() };
    if (id) {
      await sb(`portal_notices?id=eq.${encodeURIComponent(id)}`, 'PATCH', rowData);
      return NextResponse.json({ result: 'success', id });
    }
    const existing = await sb('portal_notices?select=sort_order&order=sort_order.desc&limit=1');
    const nextOrder = (existing && !existing.error && existing.length) ? existing[0].sort_order + 1 : 0;
    const created = await sb('portal_notices', 'POST', { ...rowData, sort_order: nextOrder });
    return NextResponse.json({ result: 'success', id: (created && !created.error && created[0]) ? created[0].id : null });
  }

  if (action === 'delete_notice') {
    const { id } = payload;
    if (!id) return NextResponse.json({ result: 'error', message: 'id required.' });
    await sb(`portal_notices?id=eq.${encodeURIComponent(id)}`, 'DELETE');
    return NextResponse.json({ result: 'success' });
  }

  if (action === 'reorder_notices') {
    const { ids } = payload;
    if (!Array.isArray(ids)) return NextResponse.json({ result: 'error', message: 'ids array required.' });
    await Promise.all(ids.map((id, i) => sb(`portal_notices?id=eq.${encodeURIComponent(id)}`, 'PATCH', { sort_order: i })));
    return NextResponse.json({ result: 'success' });
  }

  // ── Notifications / Diary feed ──────────────────────────────────────────────
  // ccpc-teachers (the staff-facing sibling app, same Supabase project) writes
  // rows into `teacher.notifications` for user_id = 'student:<student_id>' —
  // Student Diary entries (discipline/compliment/wish/homework), Student-
  // section Forum posts, etc. This just reads that shared feed back for the
  // logged-in student. Cross-schema read (teacher, not this app's own
  // student schema) — same pattern as _getClassTeacherName above.
  if (action === 'get_student_notifications') {
    const { student_id } = payload;
    if (!student_id) return NextResponse.json({ result: 'error', message: 'student_id required.' });
    const rows = await sb(
      `notifications?user_id=eq.${encodeURIComponent('student:' + student_id)}&order=created_at.desc&limit=100`,
      'GET', null, { 'Accept-Profile': 'teacher_staff', 'Content-Profile': 'teacher_staff' }
    );
    if (rows?.error) return NextResponse.json({ result: 'error', message: rows.error });
    const list = Array.isArray(rows) ? rows : [];
    return NextResponse.json({ result: 'success', notifications: list, unread: list.filter(r => !r.is_read).length });
  }

  if (action === 'mark_notification_read') {
    const { id } = payload;
    if (!id) return NextResponse.json({ result: 'error', message: 'id required.' });
    await sb(`notifications?id=eq.${encodeURIComponent(id)}`, 'PATCH', { is_read: true }, { 'Accept-Profile': 'teacher_staff', 'Content-Profile': 'teacher_staff' });
    return NextResponse.json({ result: 'success' });
  }

  if (action === 'mark_all_notifications_read') {
    const { student_id } = payload;
    if (!student_id) return NextResponse.json({ result: 'error', message: 'student_id required.' });
    await sb(`notifications?user_id=eq.${encodeURIComponent('student:' + student_id)}&is_read=eq.false`, 'PATCH', { is_read: true }, { 'Accept-Profile': 'teacher_staff', 'Content-Profile': 'teacher_staff' });
    return NextResponse.json({ result: 'success' });
  }

  // Read-only feed of the Forum's Student section, scoped to what THIS
  // student can actually see — teachers/Admin post targeted at a Class,
  // Class+Section, or specific student(s) (same audience shape ccpc-
  // teachers' createForumPost/Diary composer use). Narrowed server-side by
  // audience->>class first (cheap PostgREST jsonb filter), then the mode-
  // specific match (class-wide / this section / this student explicitly
  // named) is resolved in JS since that logic differs per mode.
  if (action === 'get_student_forum_posts') {
    const { student_id, class: cls, section } = payload;
    if (!student_id || !cls) return NextResponse.json({ result: 'error', message: 'student_id and class required.' });
    const rows = await sb(
      `forum_posts?section=eq.student&audience->>class=eq.${encodeURIComponent(cls)}&order=created_at.desc&limit=100&select=id,body,photo_urls,author_id,audience,created_at`,
      'GET', null, { 'Accept-Profile': 'teacher_staff', 'Content-Profile': 'teacher_staff' }
    );
    if (rows?.error) return NextResponse.json({ result: 'error', message: rows.error });
    const visible = (Array.isArray(rows) ? rows : []).filter(p => {
      const a = p.audience || {};
      if (a.mode === 'students') return (a.student_ids || []).map(String).includes(String(student_id));
      if (a.mode === 'class_section') return !section || !a.section || a.section === section;
      return true; // 'class' mode — every section
    });
    if (!visible.length) return NextResponse.json({ result: 'success', posts: [] });
    const nameById = await _resolveAuthorNames([...new Set(visible.map(p => p.author_id))]);
    visible.forEach(p => { p.author_name = nameById[p.author_id] || p.author_id; });
    return NextResponse.json({ result: 'success', posts: visible });
  }

  // A student can start a new Student-section forum post — always scoped to
  // their OWN class+section (never client-trusted: re-derived from
  // students_data server-side, same as the visibility check above works off
  // the real audience shape) so a student can never post into a class that
  // isn't theirs.
  if (action === 'create_student_forum_post') {
    const { student_id, body: postBody } = payload;
    const text = String(postBody || '').trim();
    if (!student_id || !text) return NextResponse.json({ result: 'error', message: 'student_id and a message are required.' });
    const studentRows = await sb(`students_data?student_id=eq.${encodeURIComponent(student_id)}&select=class,section`);
    const student = Array.isArray(studentRows) && studentRows[0];
    if (!student || !student.class) return NextResponse.json({ result: 'error', message: 'Could not verify your class.' });
    const now = new Date().toISOString();
    const created = await sb('forum_posts', 'POST', {
      author_id: 'student:' + student_id, post_type: 'post', body: text,
      photo_urls: [], file_attachments: [], tagged_user_ids: [],
      is_system: false, is_pinned: false, section: 'student',
      audience: { mode: 'class_section', class: student.class, section: student.section || null, student_ids: [] },
      last_activity_at: now, created_at: now,
    }, { 'Accept-Profile': 'teacher_staff', 'Content-Profile': 'teacher_staff' });
    if (created?.error) return NextResponse.json({ result: 'error', message: created.error });
    return NextResponse.json({ result: 'success', post: created[0] });
  }

  // Replies: any student who can already SEE a post (own class/section, or
  // explicitly named — get_student_forum_posts already enforces that) can
  // reply to it — no extra class check needed here since seeing the post
  // in the first place already proved that.
  if (action === 'get_student_forum_replies') {
    const { post_id } = payload;
    if (!post_id) return NextResponse.json({ result: 'error', message: 'post_id required.' });
    const rows = await sb(
      `forum_replies?post_id=eq.${encodeURIComponent(post_id)}&order=created_at.asc&select=id,body,author_id,created_at`,
      'GET', null, { 'Accept-Profile': 'teacher_staff', 'Content-Profile': 'teacher_staff' }
    );
    if (rows?.error) return NextResponse.json({ result: 'error', message: rows.error });
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return NextResponse.json({ result: 'success', replies: [] });
    const nameById = await _resolveAuthorNames([...new Set(list.map(r => r.author_id))]);
    list.forEach(r => { r.author_name = nameById[r.author_id] || r.author_id; });
    return NextResponse.json({ result: 'success', replies: list });
  }

  if (action === 'create_student_forum_reply') {
    const { student_id, post_id, body: replyBody } = payload;
    const text = String(replyBody || '').trim();
    if (!student_id || !post_id || !text) return NextResponse.json({ result: 'error', message: 'student_id, post_id, and a message are required.' });
    const now = new Date().toISOString();
    const created = await sb('forum_replies', 'POST', {
      post_id, parent_reply_id: null, author_id: 'student:' + student_id,
      body: text, photo_urls: [], tagged_user_ids: [], created_at: now,
    }, { 'Accept-Profile': 'teacher_staff', 'Content-Profile': 'teacher_staff' });
    if (created?.error) return NextResponse.json({ result: 'error', message: created.error });
    const postRows = await sb(`forum_posts?id=eq.${encodeURIComponent(post_id)}&select=reply_count`, 'GET', null, { 'Accept-Profile': 'teacher_staff', 'Content-Profile': 'teacher_staff' });
    const post = Array.isArray(postRows) && postRows[0];
    await sb(`forum_posts?id=eq.${encodeURIComponent(post_id)}`, 'PATCH', { reply_count: ((post && post.reply_count) || 0) + 1, last_activity_at: now }, { 'Accept-Profile': 'teacher_staff', 'Content-Profile': 'teacher_staff' });
    return NextResponse.json({ result: 'success', reply: created[0] });
  }

  // Full Diary entries (not just their notification stub) for this
  // student — same class-first-filter-then-mode-match approach as the
  // Forum feed above, reading teacher.student_diary_entries instead.
  if (action === 'get_student_diary_entries') {
    const { student_id, class: cls, section } = payload;
    if (!student_id || !cls) return NextResponse.json({ result: 'error', message: 'student_id and class required.' });
    const rows = await sb(
      `student_diary_entries?audience->>class=eq.${encodeURIComponent(cls)}&order=created_at.desc&limit=100&select=id,entry_type,audience,subject,message,due_date,teacher_id,created_at`,
      'GET', null, { 'Accept-Profile': 'teacher_staff', 'Content-Profile': 'teacher_staff' }
    );
    if (rows?.error) return NextResponse.json({ result: 'error', message: rows.error });
    const visible = (Array.isArray(rows) ? rows : []).filter(e => {
      const a = e.audience || {};
      if (a.mode === 'students') return (a.student_ids || []).map(String).includes(String(student_id));
      if (a.mode === 'class_section') return !section || !a.section || a.section === section;
      return true;
    });
    if (!visible.length) return NextResponse.json({ result: 'success', entries: [] });
    const teacherIds = [...new Set(visible.map(e => e.teacher_id))];
    const profiles = await sb(
      `users_profile?teacher_id=in.(${teacherIds.map(encodeURIComponent).join(',')})&select=teacher_id,full_name`,
      'GET', null, { 'Accept-Profile': 'teacher_staff', 'Content-Profile': 'teacher_staff' }
    );
    const nameById = {};
    if (Array.isArray(profiles)) profiles.forEach(p => { nameById[p.teacher_id] = p.full_name; });
    visible.forEach(e => { e.teacher_name = nameById[e.teacher_id] || e.teacher_id; });
    return NextResponse.json({ result: 'success', entries: visible });
  }

  // ── Student <-> Teacher direct messages ─────────────────────────────────────
  // Shared teacher.direct_messages table (also used by staff-to-staff
  // messaging in ccpc-teachers, and read by its Message History oversight
  // view) — student's own identity is the same 'student:<id>' prefix
  // convention used everywhere else student-facing.
  if (action === 'get_student_message_threads') {
    const { student_id } = payload;
    if (!student_id) return NextResponse.json({ result: 'error', message: 'student_id required.' });
    const sid = 'student:' + student_id;
    const rows = await sb(
      `direct_messages?or=(sender_id.eq.${encodeURIComponent(sid)},recipient_id.eq.${encodeURIComponent(sid)})&order=created_at.desc&limit=500`,
      'GET', null, { 'Accept-Profile': 'teacher_staff', 'Content-Profile': 'teacher_staff' }
    );
    if (rows?.error) return NextResponse.json({ result: 'error', message: rows.error });
    const seen = new Map();
    (Array.isArray(rows) ? rows : []).forEach(m => {
      const teacherId = m.sender_id === sid ? m.recipient_id : m.sender_id;
      if (!teacherId || teacherId.startsWith('student:')) return;
      if (!seen.has(teacherId)) seen.set(teacherId, { teacher_id: teacherId, last_message: m.message, last_at: m.created_at, unread: 0 });
      if (!m.is_read && m.recipient_id === sid) seen.get(teacherId).unread++;
    });
    const teacherIds = [...seen.keys()];
    if (teacherIds.length) {
      const profiles = await sb(
        `users_profile?teacher_id=in.(${teacherIds.map(encodeURIComponent).join(',')})&select=teacher_id,full_name,photo_url`,
        'GET', null, { 'Accept-Profile': 'teacher_staff', 'Content-Profile': 'teacher_staff' }
      );
      (Array.isArray(profiles) ? profiles : []).forEach(p => {
        const t = seen.get(p.teacher_id);
        if (t) Object.assign(t, { teacher_name: p.full_name, teacher_photo: p.photo_url });
      });
    }
    return NextResponse.json({ result: 'success', threads: [...seen.values()].sort((a, b) => new Date(b.last_at) - new Date(a.last_at)) });
  }

  if (action === 'get_student_message_thread') {
    const { student_id, teacher_id } = payload;
    if (!student_id || !teacher_id) return NextResponse.json({ result: 'error', message: 'student_id and teacher_id required.' });
    const sid = 'student:' + student_id;
    const rows = await sb(
      `direct_messages?or=(and(sender_id.eq.${encodeURIComponent(sid)},recipient_id.eq.${encodeURIComponent(teacher_id)}),and(sender_id.eq.${encodeURIComponent(teacher_id)},recipient_id.eq.${encodeURIComponent(sid)}))&order=created_at.asc&limit=500`,
      'GET', null, { 'Accept-Profile': 'teacher_staff', 'Content-Profile': 'teacher_staff' }
    );
    if (rows?.error) return NextResponse.json({ result: 'error', message: rows.error });
    // Mark the teacher's messages to this student read now that the student
    // has opened the thread — fire-and-forget, doesn't block the response.
    sb(`direct_messages?sender_id=eq.${encodeURIComponent(teacher_id)}&recipient_id=eq.${encodeURIComponent(sid)}&is_read=eq.false`, 'PATCH', { is_read: true }, { 'Accept-Profile': 'teacher_staff', 'Content-Profile': 'teacher_staff' }).catch(() => {});
    return NextResponse.json({ result: 'success', messages: Array.isArray(rows) ? rows : [] });
  }

  if (action === 'send_student_message') {
    const { student_id, teacher_id, message } = payload;
    const text = String(message || '').trim();
    if (!student_id || !teacher_id || !text) return NextResponse.json({ result: 'error', message: 'student_id, teacher_id, and message are required.' });
    const created = await sb('direct_messages', 'POST', {
      sender_id: 'student:' + student_id, recipient_id: teacher_id, message: text,
      is_read: false, created_at: new Date().toISOString(),
    }, { 'Accept-Profile': 'teacher_staff', 'Content-Profile': 'teacher_staff' });
    if (created?.error) return NextResponse.json({ result: 'error', message: created.error });
    return NextResponse.json({ result: 'success' });
  }

  // ── Login ─────────────────────────────────────────────────────────────────
  if (action === 'login') {
    const { student_id, phone_number } = payload;
    if (student_id === ADMIN_ID && phone_number === ADMIN_PASS) {
      return NextResponse.json({ result: 'success', role: 'admin', data: { student_id: 'admin', name: 'System Administrator' } });
    }
    if (!student_id || !phone_number) return NextResponse.json({ result: 'error', message: 'Credentials required.' });

    const rows = await sb(`students_data?student_id=eq.${encodeURIComponent(student_id)}&select=*`);
    if (rows?.error) return NextResponse.json({ result: 'error', message: 'Database error.' });
    if (!rows.length)  return NextResponse.json({ result: 'error', message: 'Student ID not found.' });
    const studentData = rows[0];
    studentData.class_teacher_name = await _getClassTeacherName(studentData.class, studentData.section, studentData);

    // A student-set PIN takes over login entirely — no fallback to the phone
    // columns while a PIN exists, so a stolen/known phone number alone can't
    // get in once the student has opted into stronger login security.
    const pin = String(studentData.pin || '').trim();
    if (pin) {
      if (String(phone_number).trim() !== pin) {
        return NextResponse.json({ result: 'error', message: 'This account is secured with a PIN. Please try logging in with your PIN.' });
      }
      const subRows = await sb(`portal_submissions?student_id=eq.${encodeURIComponent(student_id)}&tab_name=eq.info`);
      const existingInfo = (subRows && !subRows.error && subRows[0]) ? subRows[0].data : null;
      return NextResponse.json({ result: 'success', data: studentData, existingInfo, submittedBefore: !!existingInfo });
    }

    // No PIN set -> fall back to admin-selected columns (default: all of
    // them, if the admin has never configured this) — see
    // get/set_login_password_columns below.
    const { anyAllowed, matches } = await verifyAdminSelectedPassword(studentData, phone_number);
    if (anyAllowed && !matches) {
      return NextResponse.json({ result: 'error', message: 'Mobile verification failed.' });
    }

    // Get existing submission for "info" tab (replaces Sheet "info")
    const subRows = await sb(`portal_submissions?student_id=eq.${encodeURIComponent(student_id)}&tab_name=eq.info`);
    const existingInfo = (subRows && !subRows.error && subRows[0]) ? subRows[0].data : null;

    return NextResponse.json({ result: 'success', data: studentData, existingInfo, submittedBefore: !!existingInfo });
  }

  // ── NFC Login ─────────────────────────────────────────────────────────────
  if (action === 'nfc_login') {
    const { nfc_uid } = payload;
    if (!nfc_uid) return NextResponse.json({ result: 'error', message: 'NFC UID required.' });
    const clean = String(nfc_uid).replace(/[\s:]/g, '').toLowerCase();
    // Try original, lowercase, uppercase
    for (const uid of [nfc_uid, clean, clean.toUpperCase()]) {
      const rows = await sb(`students_data?nfc_uid=eq.${encodeURIComponent(uid)}&select=*`);
      if (!rows?.error && rows.length) {
        const studentData = rows[0];
        studentData.class_teacher_name = await _getClassTeacherName(studentData.class, studentData.section, studentData);
        const subRows = await sb(`portal_submissions?student_id=eq.${encodeURIComponent(studentData.student_id)}&tab_name=eq.info`);
        const existingInfo = (subRows && !subRows.error && subRows[0]) ? subRows[0].data : null;
        return NextResponse.json({ result: 'success', data: studentData, existingInfo, submittedBefore: !!existingInfo });
      }
    }
    return NextResponse.json({ result: 'error', message: 'NFC UID not registered.' });
  }

  // ── Register NFC ──────────────────────────────────────────────────────────
  if (action === 'register_nfc') {
    const { student_id, nfc_uid } = payload;
    if (!student_id || !nfc_uid) return NextResponse.json({ result: 'error', message: 'Student ID and NFC UID required.' });
    // return=representation so we can tell "0 rows matched" (bad student_id)
    // apart from a real success — PATCH with return=minimal reports success either way.
    const r = await sb(`students_data?student_id=eq.${encodeURIComponent(student_id)}`, 'PATCH', { nfc_uid }, { Prefer: 'return=representation' });
    if (r?.error) return NextResponse.json({ result: 'error', message: 'Update failed.' });
    if (!Array.isArray(r) || r.length === 0) return NextResponse.json({ result: 'error', message: 'Student ID not found.' });
    return NextResponse.json({ result: 'success', message: 'NFC Tag registered successfully.' });
  }

  // ── Get Public Profile ────────────────────────────────────────────────────
  // Tap-a-card / browse-by-URL public ID lookup. Deliberately a narrow
  // allowlist, NOT select=* — this is reachable by anyone who can read a
  // card's NFC UID (no login, no PIN, nothing secret about the UID itself)
  // or who just guesses/shares the URL, so it must never return anything
  // beyond "who does this ID card belong to" — no phone numbers, parent
  // names, balance, or spending limits, all of which students_data also
  // holds and get_my_fees/get_wallet-style endpoints already gate behind
  // an actual login.
  if (action === 'get_public_profile') {
    const { nfc_uid } = payload;
    const fields = 'student_id,student_name,class,section,roll,session,house,photo';
    const clean = String(nfc_uid || '').replace(/[\s:]/g, '').toLowerCase();
    for (const uid of [nfc_uid, clean, clean.toUpperCase()]) {
      const rows = await sb(`students_data?nfc_uid=eq.${encodeURIComponent(uid)}&select=${fields}`);
      if (!rows?.error && rows.length) return NextResponse.json({ result: 'success', data: rows[0] });
    }
    return NextResponse.json({ result: 'error', message: 'Student profile not found.' });
  }

  // ── Get Tabs ──────────────────────────────────────────────────────────────
  if (action === 'get_tabs') {
    const { student_id } = payload;
    const tabRows = await sb('portal_tabs?order=sort_order.asc,id.asc');
    if (tabRows?.error) return NextResponse.json([]);
    const allTabs = (tabRows || []).map(t => ({
      tab_name: t.tab_name,
      fields_json: t.fields_json || '[]',
      is_enabled: t.is_enabled,
      condition_json: t.condition_json || '{}',
      icon_class: t.icon_class || 'bi-folder-fill',
      default_editable: t.default_editable || 'YES',
      include_fields_json: t.include_fields_json || '[]',
    }));
    if (!student_id || student_id === 'admin') return NextResponse.json(allTabs);

    // Filter by conditions
    const profileRows = await sb(`students_data?student_id=eq.${encodeURIComponent(student_id)}&select=*`);
    const profile = (profileRows && !profileRows.error && profileRows[0]) ? profileRows[0] : { student_id };
    const subRows = await sb(`portal_submissions?student_id=eq.${encodeURIComponent(student_id)}&select=tab_name`);
    const submissions = subRows?.error ? [] : subRows;

    const visible = [];
    for (const tab of allTabs) {
      if (!tab.is_enabled) continue;
      let condObj = null;
      try { condObj = JSON.parse(tab.condition_json || '{}'); } catch {}
      if (!condObj || !(condObj.rules?.length)) { visible.push(tab); continue; }
      const results = await Promise.all(condObj.rules.map(r => evalRule(r, profile, submissions)));
      const pass = condObj.logic === 'OR' ? results.some(Boolean) : results.every(Boolean);
      if (pass) visible.push(tab);
    }
    return NextResponse.json(visible);
  }

  // ── Get Student Tab Data ──────────────────────────────────────────────────
  if (action === 'get_student_tab_data') {
    const { student_id, tab_name } = payload;
    const rows = await sb(`portal_submissions?student_id=eq.${encodeURIComponent(student_id)}&tab_name=eq.${encodeURIComponent(tab_name)}`);
    if (!rows?.error && rows.length) {
      const row = rows[0];
      return NextResponse.json({ ...row.data, editable: row.editable, student_id });
    }
    return NextResponse.json(null);
  }

  // ── Submit ────────────────────────────────────────────────────────────────
  if (action === 'submit') {
    const { student_id, tabName, ...data } = payload;
    if (!student_id) return NextResponse.json({ result: 'error', message: 'Student ID required.' });
    const tab_name = tabName || 'info';

    const existing = await sb(`portal_submissions?student_id=eq.${encodeURIComponent(student_id)}&tab_name=eq.${encodeURIComponent(tab_name)}`);
    if (existing?.error) return NextResponse.json({ result: 'error', message: 'Could not check existing submission: ' + existing.error });
    if (existing[0]?.editable === 'NO') {
      return NextResponse.json({ result: 'error', message: 'Permission Denied (Locked)' });
    }

    // Determine default_editable from tab config
    const tabRow = await sb(`portal_tabs?tab_name=eq.${encodeURIComponent(tab_name)}`);
    const defEdit = (tabRow && !tabRow.error && tabRow[0]) ? tabRow[0].default_editable || 'YES' : 'YES';
    const editable = existing[0] ? existing[0].editable : defEdit;
    const submittedAt = existing[0] ? existing[0].submitted_at : new Date().toISOString();

    const cleanData = Object.fromEntries(Object.entries(data).filter(([k]) => k !== 'tabName' && k !== 'editable'));

    const missingFields = missingRequiredFields(tabRow && !tabRow.error && tabRow[0] ? tabRow[0].fields_json : '[]', cleanData);
    if (missingFields.length) {
      return NextResponse.json({ result: 'error', message: `Fill in required field${missingFields.length === 1 ? '' : 's'}: ${missingFields.join(', ')}.` });
    }

    // Upsert on the (student_id, tab_name) unique key instead of a separate
    // check-then-insert-or-update — the client retries submit up to 3x on a
    // slow connection, and a plain insert-if-missing races itself into a
    // duplicate-key error on the retry, which the caller never saw because the
    // old code didn't check the write's result and always reported "success"
    // even when nothing was actually saved.
    const result = await sb(
      'portal_submissions?on_conflict=student_id,tab_name', 'POST',
      { student_id, tab_name, data: cleanData, editable, submitted_at: submittedAt, updated_at: new Date().toISOString() },
      { Prefer: 'resolution=merge-duplicates,return=representation' }
    );
    if (result?.error) return NextResponse.json({ result: 'error', message: 'Save failed: ' + result.error });
    return NextResponse.json({ result: 'success' });
  }

  // ── Get Tab Data (Admin) ──────────────────────────────────────────────────
  if (action === 'get_tab_data') {
    const { tab_name } = payload;
    const rows = await sb(`portal_submissions?tab_name=eq.${encodeURIComponent(tab_name)}&order=submitted_at.asc`);
    if (rows?.error || !rows.length) return NextResponse.json({ headers: ['student_id'], rows: [] });

    // Column order follows the tab's configuration (profile include-fields first,
    // then the form fields as arranged in the builder). Extra keys found only in
    // older submissions are appended at the end so no data is ever hidden.
    const tabRow = await sb(`portal_tabs?tab_name=eq.${encodeURIComponent(tab_name)}`);
    const cfg = (!tabRow?.error && tabRow[0]) ? tabRow[0] : null;
    const ordered = ['student_id'];
    if (cfg) {
      try {
        JSON.parse(cfg.include_fields_json || '[]').forEach(k => { if (k && !ordered.includes(k)) ordered.push(k); });
      } catch {}
      try {
        JSON.parse(cfg.fields_json || '[]').forEach(f => {
          const k = f?.data_key || f?.id;
          if (k && f.type !== 'group_label' && !ordered.includes(k)) ordered.push(k);
        });
      } catch {}
    }
    const extras = new Set();
    rows.forEach(r => Object.keys(r.data || {}).forEach(k => { if (!ordered.includes(k)) extras.add(k); }));
    const headers = [...ordered, ...extras];
    const dataRows = rows.map(r => headers.map(h => h === 'student_id' ? r.student_id : (r.data?.[h] ?? '')));
    return NextResponse.json({ headers, rows: dataRows });
  }

  // ── Get Student Data Headers ──────────────────────────────────────────────
  if (action === 'get_student_data_headers') {
    const rows = await sb('students_data?limit=1');
    if (!rows?.error && rows.length) return NextResponse.json(Object.keys(rows[0]));
    return NextResponse.json(['student_id', 'student_name', 'class', 'section', 'roll']);
  }

  // ── Distinct class/house values (admin's Group Form eligibility builder) ───
  // Full table scan via sbAllRows, not a single ?limit=N page — a class or
  // house that happens to sort past the first page must never silently be
  // unpickable when building a band.
  if (action === 'get_class_house_options') {
    const rows = await sbAllRows('students_data?select=class,section,house');
    if (rows?.error) return NextResponse.json({ result: 'error', message: rows.error });
    const classes = [...new Set(rows.map(r => r.class).filter(Boolean))].sort();
    const houses = [...new Set(rows.map(r => r.house).filter(Boolean))].sort();
    const sections = [...new Set(rows.map(r => r.section).filter(Boolean))].sort();
    // Per-class section list — the same section code (e.g. "B") can mean a
    // different room across classes, so the Group Form teammate search's
    // Section dropdown cascades off the chosen Class instead of listing
    // every section school-wide.
    const classSectionSets = {};
    rows.forEach(r => {
      if (!r.class || !r.section) return;
      (classSectionSets[r.class] = classSectionSets[r.class] || new Set()).add(r.section);
    });
    const classSections = {};
    Object.keys(classSectionSets).forEach(k => { classSections[k] = [...classSectionSets[k]].sort(); });
    return NextResponse.json({ result: 'success', classes, houses, sections, classSections });
  }

  // ── Distinct values of an arbitrary students_data column (admin's Group
  // Form eligibility builder's "Group by" field — any header, not just
  // class) ─────────────────────────────────────────────────────────────────
  // `field` becomes a raw column name in the PostgREST select — restricted to
  // identifier-safe characters so it can only ever reference a real column
  // (an unknown one just 400s from Postgres, not a security risk) rather than
  // any kind of query injection.
  if (action === 'get_field_values') {
    const field = String(payload?.field || '').trim();
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field)) return NextResponse.json({ result: 'error', message: 'Invalid field name.' });
    const rows = await sbAllRows(`students_data?select=${field}`);
    if (rows?.error) return NextResponse.json({ result: 'error', message: 'Could not read that column — ' + rows.error });
    const values = [...new Set(rows.map(r => r[field]).filter(v => v !== null && v !== undefined && String(v).trim() !== ''))]
      .map(String).sort();
    return NextResponse.json({ result: 'success', values });
  }

  // ── Bulk import: check which student_ids already exist (no writes) ─────────
  if (action === 'preview_bulk_import') {
    const ids = Array.isArray(payload.student_ids) ? [...new Set(payload.student_ids.map(String).filter(Boolean))] : [];
    if (ids.length === 0) return NextResponse.json({ result: 'error', message: 'No Student IDs found in the mapped file.' });
    const existing = new Set();
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const rows = await sb(`students_data?student_id=in.(${chunk.map(encodeURIComponent).join(',')})&select=student_id`);
      if (!rows?.error) rows.forEach(r => existing.add(String(r.student_id)));
    }
    return NextResponse.json({
      result: 'success',
      totalCount: ids.length,
      existingCount: existing.size,
      newCount: ids.length - existing.size,
    });
  }

  // ── Bulk import: insert only students whose student_id is not already present ──
  if (action === 'bulk_import_new_students') {
    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    const updateExisting = !!payload.update_existing;
    if (rows.length === 0) return NextResponse.json({ result: 'error', message: 'No rows to import.' });

    // Only real, existing columns may be written — never trust client-sent keys directly
    const schemaRows = await sb('students_data?limit=1');
    if (schemaRows?.error || !schemaRows.length) return NextResponse.json({ result: 'error', message: 'Could not read student schema.' });
    const allowedCols = new Set(Object.keys(schemaRows[0]).filter(c => c !== 'id'));

    let skippedMissingId = 0;
    const seenInFile = new Set();
    let skippedDuplicateInFile = 0;
    const clean = [];
    for (const row of rows) {
      const sid = String(row.student_id || '').trim();
      if (!sid) { skippedMissingId++; continue; }
      if (seenInFile.has(sid)) { skippedDuplicateInFile++; continue; }
      seenInFile.add(sid);
      const cleanRow = {};
      for (const [k, v] of Object.entries(row)) {
        if (allowedCols.has(k) && v !== '' && v !== null && v !== undefined) cleanRow[k] = v;
      }
      cleanRow.student_id = sid;
      clean.push(cleanRow);
    }

    // Find which of these student_ids already exist
    const ids = clean.map(r => r.student_id);
    const existing = new Set();
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const existRows = await sb(`students_data?student_id=in.(${chunk.map(encodeURIComponent).join(',')})&select=student_id`);
      if (!existRows?.error) existRows.forEach(r => existing.add(String(r.student_id)));
    }
    const toInsert = clean.filter(r => !existing.has(r.student_id));
    const toUpdate = updateExisting ? clean.filter(r => existing.has(r.student_id)) : [];

    let inserted = 0;
    const insertErrors = [];
    for (let i = 0; i < toInsert.length; i += 200) {
      const chunk = toInsert.slice(i, i + 200);
      const res = await sb('students_data', 'POST', chunk);
      if (res?.error) insertErrors.push(res.error);
      else inserted += chunk.length;
    }

    // Existing students: PATCH each by student_id, only with the mapped fields for that row
    // (never blanks out columns the file didn't provide). Run with limited concurrency.
    let updated = 0;
    const updateErrors = [];
    for (let i = 0; i < toUpdate.length; i += 20) {
      const chunk = toUpdate.slice(i, i + 20);
      const results = await Promise.all(chunk.map(row => {
        const { student_id, ...fields } = row;
        if (Object.keys(fields).length === 0) return Promise.resolve({ skipped: true });
        return sb(`students_data?student_id=eq.${encodeURIComponent(student_id)}`, 'PATCH', fields);
      }));
      results.forEach(r => { if (r?.error) updateErrors.push(r.error); else if (!r?.skipped) updated++; });
    }

    return NextResponse.json({
      result: (insertErrors.length || updateErrors.length) ? 'partial' : 'success',
      inserted,
      updated,
      skipped_existing: updateExisting ? 0 : existing.size,
      skipped_missing_id: skippedMissingId,
      skipped_duplicate_in_file: skippedDuplicateInFile,
      errors: [...insertErrors, ...updateErrors],
    });
  }

  // ── Get list of profile fields the admin marked student-editable ───────────
  if (action === 'get_editable_fields') {
    const setRows = await sb('portal_settings?key=eq.editable_profile_fields');
    let fields = [];
    try { fields = JSON.parse((setRows && !setRows.error && setRows[0]?.value) || '[]'); } catch (_) {}
    return NextResponse.json({ fields: Array.isArray(fields) ? fields : [] });
  }

  // ── Distinct group values already in use, for the profile-edit dropdown —
  // 'group' is a fixed-choice field, but the choices come from whatever the
  // school has actually assigned (via bulk import), not a hardcoded enum.
  if (action === 'get_group_values') {
    const rows = await sb('students_data?select=group&limit=10000');
    const values = new Set(['None']);
    (Array.isArray(rows) ? rows : []).forEach(r => { const g = String(r.group || '').trim(); if (g) values.add(g); });
    return NextResponse.json({ values: Array.from(values).sort((a, b) => a === 'None' ? -1 : b === 'None' ? 1 : a.localeCompare(b)) });
  }

  // ── Admin saves which profile fields students may edit ─────────────────────
  if (action === 'save_editable_fields') {
    const fields = Array.isArray(payload.fields) ? payload.fields : [];
    const r = await psSave('editable_profile_fields', JSON.stringify(fields));
    if (!r.ok) return NextResponse.json({ result: 'error', message: r.message });
    return NextResponse.json({ result: 'success' });
  }

  // ── Distinct house values already in use, for the admin's House Colors
  // picker — mirrors get_group_values exactly (same "whatever's actually in
  // students_data, not a hardcoded enum" reasoning).
  if (action === 'get_house_values') {
    const rows = await sb('students_data?select=house&limit=10000');
    const values = new Set();
    (Array.isArray(rows) ? rows : []).forEach(r => { const h = String(r.house || '').trim(); if (h) values.add(h); });
    return NextResponse.json({ values: Array.from(values).sort() });
  }

  // ── House colors — purely cosmetic: themes a student's own Personal Hub
  // avatar/accent by their house, one admin-picked color per house. Same
  // portal_settings key-value pattern as editable_profile_fields; readable
  // by anyone (a color mapping isn't sensitive) so a logged-in student's own
  // page can apply it without a separate admin check.
  if (action === 'get_house_colors') {
    const rows = await sb('portal_settings?key=eq.house_colors');
    let colors = {};
    try { colors = JSON.parse((rows && !rows.error && rows[0]?.value) || '{}'); } catch (_) {}
    return NextResponse.json({ result: 'success', colors: (colors && typeof colors === 'object' && !Array.isArray(colors)) ? colors : {} });
  }
  if (action === 'save_house_colors') {
    const colors = payload.colors;
    if (!colors || typeof colors !== 'object' || Array.isArray(colors)) {
      return NextResponse.json({ result: 'error', message: 'colors must be an object.' });
    }
    const clean = {};
    Object.entries(colors).forEach(([house, color]) => {
      const h = String(house || '').trim();
      const c = String(color || '').trim();
      if (h && /^#[0-9a-fA-F]{6}$/.test(c)) clean[h] = c;
    });
    const r = await psSave('house_colors', JSON.stringify(clean));
    if (!r.ok) return NextResponse.json({ result: 'error', message: r.message });
    return NextResponse.json({ result: 'success' });
  }

  // ── Student updates their own profile (only admin-approved fields) ─────────
  if (action === 'update_student_profile') {
    const { student_id, updates } = payload;
    if (!student_id || student_id === 'admin' || !updates || typeof updates !== 'object') {
      return NextResponse.json({ result: 'error', message: 'Invalid request.' });
    }
    const setRows = await sb('portal_settings?key=eq.editable_profile_fields');
    let allowed = [];
    try { allowed = JSON.parse((setRows && !setRows.error && setRows[0]?.value) || '[]'); } catch (_) {}
    if (!Array.isArray(allowed) || allowed.length === 0) {
      return NextResponse.json({ result: 'error', message: 'Profile editing is currently disabled.' });
    }
    // Never allow identity/system columns to be overwritten, even if listed
    const locked = new Set(['id', 'student_id', 'nfc_uid', 'balance', 'daily_limit', 'monthly_limit', 'card_status', 'submitted_at']);
    const clean = {};
    for (const [k, v] of Object.entries(updates)) {
      if (allowed.includes(k) && !locked.has(k)) clean[k] = v;
    }
    if (Object.keys(clean).length === 0) {
      return NextResponse.json({ result: 'error', message: 'No editable fields to update.' });
    }
    const r = await sb(`students_data?student_id=eq.${encodeURIComponent(student_id)}`, 'PATCH', clean);
    if (r?.error) return NextResponse.json({ result: 'error', message: 'Update failed.' });
    const fresh = await sb(`students_data?student_id=eq.${encodeURIComponent(student_id)}&select=*`);
    return NextResponse.json({ result: 'success', data: (fresh && !fresh.error && fresh[0]) ? fresh[0] : clean });
  }

  // ── Which tabs have been promoted into the profile ─────────────────────────
  if (action === 'get_profile_sections') {
    const rows = await sb('portal_settings?key=eq.profile_sections');
    let sections = [];
    try { sections = JSON.parse((rows && !rows.error && rows[0]?.value) || '[]'); } catch (_) {}
    return NextResponse.json({ sections: Array.isArray(sections) ? sections : [] });
  }

  // ── Promote a whole tab into the student profile (adds real columns) ───────
  if (action === 'promote_tab_to_profile') {
    const { tab_name } = payload;
    if (!tab_name) return NextResponse.json({ result: 'error', message: 'tab_name required.' });
    const tabRows = await sb(`portal_tabs?tab_name=eq.${encodeURIComponent(tab_name)}`);
    if (tabRows?.error || !tabRows.length) return NextResponse.json({ result: 'error', message: 'Tab not found.' });
    let fields = [];
    try { fields = JSON.parse(tabRows[0].fields_json || '[]'); } catch (_) {}
    // Only real input fields become columns; group headers are skipped. Valid pg identifiers only.
    const valid = /^[a-z][a-z0-9_]{0,62}$/;
    const inputFields = fields.filter(f => f.type !== 'group_label' && f.data_key && valid.test(f.data_key));
    const cols = inputFields.map(f => f.data_key);
    if (cols.length === 0) return NextResponse.json({ result: 'error', message: 'No valid fields to add.' });

    // 1) Add the columns (SECURITY DEFINER RPC — validated identifiers, text type)
    const addRes = await sb('rpc/add_profile_columns', 'POST', { cols });
    if (addRes?.error) return NextResponse.json({ result: 'error', message: 'Could not add columns: ' + (addRes.error.message || addRes.error) });
    // 2) Backfill existing submissions into the new columns
    const syncRes = await sb('rpc/sync_tab_to_columns', 'POST', { p_tab: tab_name, keys: cols });
    if (syncRes?.error) return NextResponse.json({ result: 'error', message: 'Columns added but backfill failed: ' + (syncRes.error.message || syncRes.error) });

    // 3) Record the section so the Personal Hub shows it as a profile group
    const secRows = await sb('portal_settings?key=eq.profile_sections');
    let sections = [];
    try { sections = JSON.parse((secRows && !secRows.error && secRows[0]?.value) || '[]'); } catch (_) {}
    const fieldMeta = inputFields.map(f => ({ data_key: f.data_key, label: f.name || f.data_key, type: f.type || 'text', options: f.options || [], show_if: f.show_if || null }));
    const title = tab_name.charAt(0).toUpperCase() + tab_name.slice(1).replace(/_/g, ' ');
    sections = (Array.isArray(sections) ? sections : []).filter(s => s.tab_name !== tab_name);
    sections.push({ tab_name, title, fields: fieldMeta });
    const secSave = await psSave('profile_sections', JSON.stringify(sections));
    if (!secSave.ok) return NextResponse.json({ result: 'error', message: 'Columns added but profile section save failed: ' + secSave.message });

    return NextResponse.json({ result: 'success', added: cols.length, columns: cols });
  }

  // ── Remove a tab from the profile view (keeps the columns & their data) ────
  if (action === 'unpromote_tab_from_profile') {
    const { tab_name } = payload;
    if (!tab_name) return NextResponse.json({ result: 'error', message: 'tab_name required.' });
    const secRows = await sb('portal_settings?key=eq.profile_sections');
    let sections = [];
    try { sections = JSON.parse((secRows && !secRows.error && secRows[0]?.value) || '[]'); } catch (_) {}
    sections = (Array.isArray(sections) ? sections : []).filter(s => s.tab_name !== tab_name);
    const r = await psSave('profile_sections', JSON.stringify(sections));
    if (!r.ok) return NextResponse.json({ result: 'error', message: r.message });
    return NextResponse.json({ result: 'success' });
  }

  // ── Save Tab Config ───────────────────────────────────────────────────────
  if (action === 'save_tab') {
    const { tab_name, fields_json, is_enabled, condition_json, icon_class, default_editable, include_fields_json } = payload;
    if (!tab_name) return NextResponse.json({ result: 'error', message: 'Tab name required.' });
    const existing = await sb(`portal_tabs?tab_name=eq.${encodeURIComponent(tab_name)}`);
    if (existing?.error) return NextResponse.json({ result: 'error', message: 'Could not look up existing tab: ' + existing.error });
    const rowData = { tab_name, fields_json, is_enabled, condition_json, icon_class, default_editable, include_fields_json };
    const writeRes = existing.length
      ? await sb(`portal_tabs?tab_name=eq.${encodeURIComponent(tab_name)}`, 'PATCH', rowData)
      : await sb('portal_tabs', 'POST', { ...rowData, sort_order: 0 });
    if (writeRes?.error) return NextResponse.json({ result: 'error', message: 'Save failed: ' + writeRes.error });
    return NextResponse.json({ result: 'success' });
  }

  // ── Delete Tab ────────────────────────────────────────────────────────────
  if (action === 'delete_tab') {
    const r = await sb(`portal_tabs?tab_name=eq.${encodeURIComponent(payload.tab_name)}`, 'DELETE');
    if (r?.error) return NextResponse.json({ result: 'error', message: r.error });
    return NextResponse.json({ result: 'success' });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Group Forms — a form where several students submit ONE shared entry
  // together as a team (e.g. Science Fair sign-up), instead of the ordinary
  // portal_tabs one-student-alone form above. "Group Form" is the admin-built
  // template (group_forms); "Team" is the student-built roster inside one
  // (group_form_teams / group_form_team_members / group_form_team_invites).
  // ══════════════════════════════════════════════════════════════════════════

  // ── Get Group Forms ──────────────────────────────────────────────────────
  // Same double-duty shape as get_tabs above: no student_id (or 'admin') ->
  // every form, enabled or not, for the admin list. A real student_id -> only
  // enabled forms, each annotated with that student's own status for it
  // (no_team / has_pending_invite / is_leader / is_member) so the client can
  // add a nav entry per form and badge the ones needing a response, the same
  // way get_tabs lets the student nav loop work off one call.
  if (action === 'get_group_forms') {
    const { student_id } = payload;
    const rows = await sb('group_forms?order=sort_order.asc,id.asc');
    if (rows?.error) return NextResponse.json([]);
    const allForms = Array.isArray(rows) ? rows : [];
    if (!student_id || student_id === 'admin') return NextResponse.json(allForms);

    let enabled = allForms.filter(f => f.is_enabled);
    if (!enabled.length) return NextResponse.json([]);

    // Same tab-level "Logic Rules" gate portal_tabs uses (condition_json),
    // reusing the exact same evalRule() evaluator get_tabs uses above — e.g.
    // "class equals Ten" — so a Group Form can be restricted to a subset of
    // students instead of showing to everyone once enabled.
    const profileRows = await sb(`students_data?student_id=eq.${encodeURIComponent(student_id)}&select=*`);
    const profile = (profileRows && !profileRows.error && profileRows[0]) ? profileRows[0] : { student_id };
    const subRows = await sb(`portal_submissions?student_id=eq.${encodeURIComponent(student_id)}&select=tab_name`);
    const submissions = subRows?.error ? [] : subRows;
    const conditionVisible = [];
    for (const f of enabled) {
      let condObj = null;
      try { condObj = JSON.parse(f.condition_json || '{}'); } catch {}
      if (!condObj || !(condObj.rules?.length)) { conditionVisible.push(f); continue; }
      const results = await Promise.all(condObj.rules.map(r => evalRule(r, profile, submissions)));
      const pass = condObj.logic === 'OR' ? results.some(Boolean) : results.every(Boolean);
      if (pass) conditionVisible.push(f);
    }
    enabled = conditionVisible;
    if (!enabled.length) return NextResponse.json([]);

    // accepting_eligible is the final "can this student start a new team"
    // verdict, exposed so the client can show the right message up front
    // instead of only failing after the whole Create Team form is filled in
    // (create_group re-checks this regardless either way). When
    // accepting_condition_json has rules configured, it is AUTHORITATIVE —
    // overriding the plain accepting_new switch in BOTH directions. That's
    // what lets an admin flip Open OFF (closed to everyone) while still
    // listing a specific student_id in the Filter to let just that student
    // through, e.g. a late registrant let in without reopening to everyone.
    // No rules configured (the default): falls back to the plain switch,
    // same as before this column existed.
    for (const f of enabled) {
      let acceptCondObj = null;
      try { acceptCondObj = JSON.parse(f.accepting_condition_json || '{}'); } catch {}
      if (!acceptCondObj || !(acceptCondObj.rules?.length)) { f.accepting_eligible = f.accepting_new !== false; continue; }
      const results = await Promise.all(acceptCondObj.rules.map(r => evalRule(r, profile, submissions)));
      f.accepting_eligible = acceptCondObj.logic === 'OR' ? results.some(Boolean) : results.every(Boolean);
    }

    const [memberRows, inviteRows] = await Promise.all([
      sb(`group_form_team_members?student_id=eq.${encodeURIComponent(student_id)}&select=group_form_id,role`),
      sb(`group_form_team_invites?invited_student_id=eq.${encodeURIComponent(student_id)}&status=eq.pending&select=group_form_id`),
    ]);
    const memberByForm = {};
    (Array.isArray(memberRows) ? memberRows : []).forEach(m => { memberByForm[m.group_form_id] = m; });
    const invitedForms = new Set((Array.isArray(inviteRows) ? inviteRows : []).map(i => i.group_form_id));

    const annotated = enabled.map(f => {
      const mem = memberByForm[f.id];
      const my_status = mem ? (mem.role === 'leader' ? 'is_leader' : 'is_member')
        : (invitedForms.has(f.id) ? 'has_pending_invite' : 'no_team');
      return { ...f, my_status };
    });
    return NextResponse.json(annotated);
  }

  // ── Save Group Form Config (admin) ──────────────────────────────────────
  if (action === 'save_group_form') {
    const { id, title, header, sub_header, description, icon_class, cover_photo_url, max_team_size, members_required, fields_json, eligibility_json, condition_json, accepting_condition_json, is_enabled, accepting_new, lock_when_closed, sort_order } = payload;

    if (id) {
      // Partial update — only touches fields actually sent. The admin card's
      // Active/Open switches call this with just {id, is_enabled} or
      // {id, accepting_new}; building a full row with fallback defaults for
      // everything else here would silently overwrite the title, icon and —
      // worst of all — reset fields_json to '[]', wiping every field on a
      // simple toggle click.
      const rowData = { updated_at: new Date().toISOString() };
      if (title !== undefined) {
        if (!String(title).trim()) return NextResponse.json({ result: 'error', message: 'Title required.' });
        rowData.title = String(title).trim();
      }
      if (header !== undefined) rowData.header = header || null;
      if (sub_header !== undefined) rowData.sub_header = sub_header || null;
      if (description !== undefined) rowData.description = description || null;
      if (icon_class !== undefined) rowData.icon_class = icon_class || 'bi-people-fill';
      if (cover_photo_url !== undefined) rowData.cover_photo_url = cover_photo_url || null;
      if (max_team_size !== undefined) rowData.max_team_size = Math.max(1, Number(max_team_size) || 4);
      if (members_required !== undefined) rowData.members_required = !!members_required;
      if (fields_json !== undefined) rowData.fields_json = fields_json || '[]';
      if (eligibility_json !== undefined) rowData.eligibility_json = eligibility_json || '{}';
      if (condition_json !== undefined) rowData.condition_json = condition_json || '{}';
      if (accepting_condition_json !== undefined) rowData.accepting_condition_json = accepting_condition_json || '{}';
      if (is_enabled !== undefined) rowData.is_enabled = !!is_enabled;
      if (accepting_new !== undefined) rowData.accepting_new = !!accepting_new;
      if (lock_when_closed !== undefined) rowData.lock_when_closed = !!lock_when_closed;
      if (sort_order !== undefined) rowData.sort_order = sort_order;
      const writeRes = await sb(`group_forms?id=eq.${encodeURIComponent(id)}`, 'PATCH', rowData);
      if (writeRes?.error) return NextResponse.json({ result: 'error', message: 'Save failed: ' + writeRes.error });
      return NextResponse.json({ result: 'success' });
    }

    // Create — every field gets a real default.
    if (!title || !String(title).trim()) return NextResponse.json({ result: 'error', message: 'Title required.' });
    const rowData = {
      title: String(title).trim(),
      header: header || null,
      sub_header: sub_header || null,
      description: description || null,
      icon_class: icon_class || 'bi-people-fill',
      cover_photo_url: cover_photo_url || null,
      max_team_size: Math.max(1, Number(max_team_size) || 4),
      members_required: !!members_required,
      fields_json: fields_json || '[]',
      eligibility_json: eligibility_json || '{}',
      condition_json: condition_json || '{}',
      accepting_condition_json: accepting_condition_json || '{}',
      is_enabled: is_enabled !== false,
      accepting_new: accepting_new !== false,
      lock_when_closed: !!lock_when_closed,
      sort_order: sort_order || 0,
    };
    const writeRes = await sb('group_forms', 'POST', rowData);
    if (writeRes?.error) return NextResponse.json({ result: 'error', message: 'Save failed: ' + writeRes.error });
    return NextResponse.json({ result: 'success' });
  }

  // ── Upload a Group Form's cover photo (admin) ────────────────────────────
  // Returns a public URL for the admin to attach via save_group_form's
  // cover_photo_url — deliberately doesn't touch group_forms itself, so it
  // works the same whether editing an existing form or still filling in a
  // brand-new one that has no id yet. Same "students" storage bucket (and
  // its 130KB file-size limit) the profile-photo uploader already uses,
  // just a differently-prefixed, uniquely-named file — no new bucket needed.
  if (action === 'upload_group_form_cover') {
    const { photo_base64 } = payload;
    if (!photo_base64) return NextResponse.json({ result: 'error', message: 'Photo required.' });
    const raw = String(photo_base64).replace(/^data:[^;]+;base64,/, '');
    const binary = atob(raw);
    const buf = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
    const contentType = (String(photo_base64).match(/data:([^;]+)/) || [])[1] || 'image/jpeg';
    const key = `group_form_cover_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`;

    const uploadRes = await fetch(`${SB_URL}/storage/v1/object/students/${key}`, {
      method: 'POST',
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': contentType, 'x-upsert': 'true' },
      body: buf,
    });
    if (!uploadRes.ok) return NextResponse.json({ result: 'error', message: 'Upload failed: ' + (await uploadRes.text()).slice(0, 200) });

    const publicUrl = `${SB_URL}/storage/v1/object/public/students/${key}`;
    return NextResponse.json({ result: 'success', url: publicUrl });
  }

  // ── Delete Group Form (admin) ────────────────────────────────────────────
  // Cascades to every team/member/invite under it, same as delete_tab
  // cascading to portal_submissions above.
  if (action === 'delete_group_form') {
    const { id } = payload;
    if (!id) return NextResponse.json({ result: 'error', message: 'id required.' });
    await sb(`group_form_team_invites?group_form_id=eq.${encodeURIComponent(id)}`, 'DELETE');
    await sb(`group_form_team_members?group_form_id=eq.${encodeURIComponent(id)}`, 'DELETE');
    await sb(`group_form_teams?group_form_id=eq.${encodeURIComponent(id)}`, 'DELETE');
    const r = await sb(`group_forms?id=eq.${encodeURIComponent(id)}`, 'DELETE');
    if (r?.error) return NextResponse.json({ result: 'error', message: r.error });
    return NextResponse.json({ result: 'success' });
  }

  // ── View every team under one Group Form (admin) ─────────────────────────
  if (action === 'get_group_form_roster') {
    const { group_form_id } = payload;
    if (!group_form_id) return NextResponse.json({ result: 'error', message: 'group_form_id required.' });
    const [teams, members, invites] = await Promise.all([
      sb(`group_form_teams?group_form_id=eq.${encodeURIComponent(group_form_id)}&order=created_at.asc`),
      sb(`group_form_team_members?group_form_id=eq.${encodeURIComponent(group_form_id)}`),
      sb(`group_form_team_invites?group_form_id=eq.${encodeURIComponent(group_form_id)}&status=eq.pending`),
    ]);
    if (teams?.error) return NextResponse.json({ result: 'error', message: teams.error });
    const memberList = Array.isArray(members) ? members : [];
    const inviteList = Array.isArray(invites) ? invites : [];
    const ids = [...new Set([...memberList.map(m => m.student_id), ...inviteList.map(i => i.invited_student_id)])];
    const nameById = {};
    if (ids.length) {
      // Broader select than the student-facing get_my_team uses — this is
      // the admin roster's own query, which now also powers the clickable
      // "full student info + call" popup, so it needs phone/roll/parent
      // names too, not just enough to label a chip.
      const profRows = await sb(`students_data?student_id=in.(${ids.map(encodeURIComponent).join(',')})&select=student_id,student_name,class,section,roll,house,session,phone_number,father_phone,mother_phone,fathers_name,mothers_name,photo`);
      (Array.isArray(profRows) ? profRows : []).forEach(p => { nameById[p.student_id] = p; });
    }
    const membersByTeam = {};
    memberList.forEach(m => { (membersByTeam[m.team_id] = membersByTeam[m.team_id] || []).push({ ...m, profile: nameById[m.student_id] || null }); });
    const invitesByTeam = {};
    inviteList.forEach(i => { (invitesByTeam[i.team_id] = invitesByTeam[i.team_id] || []).push({ ...i, profile: nameById[i.invited_student_id] || null }); });
    const teamRows = (Array.isArray(teams) ? teams : []).map(t => ({
      ...t,
      members: membersByTeam[t.id] || [],
      pending_invites: invitesByTeam[t.id] || [],
    }));
    return NextResponse.json({ result: 'success', teams: teamRows });
  }

  // ── Lock / Unlock one team (admin) ───────────────────────────────────────
  if (action === 'set_team_lock') {
    const { team_id, locked } = payload;
    if (!team_id) return NextResponse.json({ result: 'error', message: 'team_id required.' });
    const r = await sb(`group_form_teams?id=eq.${encodeURIComponent(team_id)}`, 'PATCH', { is_locked: !!locked, updated_at: new Date().toISOString() });
    if (r?.error) return NextResponse.json({ result: 'error', message: r.error });
    return NextResponse.json({ result: 'success' });
  }

  // ── Force-disband a team (admin escape hatch) ────────────────────────────
  if (action === 'admin_disband_team') {
    const { team_id } = payload;
    if (!team_id) return NextResponse.json({ result: 'error', message: 'team_id required.' });
    await sb(`group_form_team_invites?team_id=eq.${encodeURIComponent(team_id)}&status=eq.pending`, 'PATCH', { status: 'cancelled', responded_at: new Date().toISOString() });
    await sb(`group_form_team_members?team_id=eq.${encodeURIComponent(team_id)}`, 'DELETE');
    const r = await sb(`group_form_teams?id=eq.${encodeURIComponent(team_id)}`, 'PATCH', { status: 'disbanded', updated_at: new Date().toISOString() });
    if (r?.error) return NextResponse.json({ result: 'error', message: r.error });
    return NextResponse.json({ result: 'success' });
  }

  // ── Permanently delete a team/entry (admin) ──────────────────────────────
  // Unlike admin_disband_team (which keeps the team on record as a disbanded
  // row, purely so members get freed to join elsewhere), this is a genuine
  // hard delete — every invite and member row plus the team row itself,
  // gone for good. For removing a mistaken/duplicate/test entry entirely,
  // not for freeing members from a real one.
  if (action === 'admin_delete_team') {
    const { team_id } = payload;
    if (!team_id) return NextResponse.json({ result: 'error', message: 'team_id required.' });
    await sb(`group_form_team_invites?team_id=eq.${encodeURIComponent(team_id)}`, 'DELETE');
    await sb(`group_form_team_members?team_id=eq.${encodeURIComponent(team_id)}`, 'DELETE');
    const r = await sb(`group_form_teams?id=eq.${encodeURIComponent(team_id)}`, 'DELETE');
    if (r?.error) return NextResponse.json({ result: 'error', message: r.error });
    return NextResponse.json({ result: 'success' });
  }

  // ── Send a submitted team back to the leader for edits, with a comment ──
  // Clears is_submitted/is_locked exactly like the pre-submission state —
  // the leader's view re-opens invites/editing/member changes automatically
  // since every one of those checks already just reads !is_submitted &&
  // !is_locked. The comment is shown to the leader until they resubmit.
  if (action === 'request_team_changes') {
    const { team_id, comment } = payload;
    if (!team_id || !comment || !String(comment).trim()) return NextResponse.json({ result: 'error', message: 'team_id and a comment are required.' });

    const teamRows0 = await sb(`group_form_teams?id=eq.${encodeURIComponent(team_id)}`);
    const team0 = (!teamRows0?.error && teamRows0[0]) ? teamRows0[0] : null;

    const r = await sb(`group_form_teams?id=eq.${encodeURIComponent(team_id)}`, 'PATCH', {
      is_submitted: false,
      submitted_at: null,
      is_locked: false,
      revision_comment: String(comment).trim(),
      revision_requested_at: new Date().toISOString(),
      revision_requested_by: 'admin',
      revision_requested_by_name: 'Admin',
      updated_at: new Date().toISOString(),
    });
    if (r?.error) return NextResponse.json({ result: 'error', message: r.error });

    // Notify every member of the team, not just the leader. Best-effort —
    // a notification failure must never mask the revision request that
    // already succeeded above.
    try {
      if (team0) {
        const [memberRows, formRows] = await Promise.all([
          sb(`group_form_team_members?team_id=eq.${encodeURIComponent(team_id)}&select=student_id`),
          sb(`group_forms?id=eq.${encodeURIComponent(team0.group_form_id)}&select=title`),
        ]);
        const members = Array.isArray(memberRows) ? memberRows : [];
        const formTitle = (!formRows?.error && formRows[0]?.title) || 'your team registration';
        if (members.length) {
          const now = new Date().toISOString();
          const rows = members.map(m => ({
            user_id: 'student:' + m.student_id,
            type: 'group_form_revision',
            title: `Changes requested — ${formTitle}`,
            message: `Admin asked for changes to your team's submission: ${String(comment).trim()}`,
            data: { team_id: Number(team_id), group_form_id: team0.group_form_id },
            is_read: false,
            created_at: now,
          }));
          await sb('notifications', 'POST', rows, { 'Accept-Profile': 'teacher_staff', 'Content-Profile': 'teacher_staff' });
        }
      }
    } catch (e) {
      console.error('request_team_changes notification failed:', e);
    }

    return NextResponse.json({ result: 'success' });
  }

  // ── Approve / Reject a submission (admin's own verdict) ──────────────────
  // Deliberately independent of is_submitted/is_locked/revision_comment —
  // that whole family is about whether the leader can still edit the team;
  // this is just the admin's opinion of a submission, re-settable any
  // number of times, never freezes or reopens anything.
  if (action === 'set_team_review_status') {
    const { team_id, status } = payload;
    if (!team_id) return NextResponse.json({ result: 'error', message: 'team_id required.' });
    if (status !== 'approved' && status !== 'rejected' && status !== null) {
      return NextResponse.json({ result: 'error', message: "status must be 'approved', 'rejected', or null." });
    }
    const r = await sb(`group_form_teams?id=eq.${encodeURIComponent(team_id)}`, 'PATCH', {
      review_status: status,
      review_status_by: status ? 'admin' : null,
      review_status_at: status ? new Date().toISOString() : null,
    });
    if (r?.error) return NextResponse.json({ result: 'error', message: r.error });

    // Notify every member of the team when a real verdict is set — not when
    // cleared back to null (Unapprove/Unreject is an administrative
    // correction, not news the student needs pushed to them). Same
    // best-effort pattern as request_team_changes above.
    if (status === 'approved' || status === 'rejected') {
      try {
        const teamRows = await sb(`group_form_teams?id=eq.${encodeURIComponent(team_id)}&select=group_form_id`);
        const groupFormId = (!teamRows?.error && teamRows[0]) ? teamRows[0].group_form_id : null;
        if (groupFormId) {
          const [memberRows, formRows] = await Promise.all([
            sb(`group_form_team_members?team_id=eq.${encodeURIComponent(team_id)}&select=student_id`),
            sb(`group_forms?id=eq.${encodeURIComponent(groupFormId)}&select=title`),
          ]);
          const members = Array.isArray(memberRows) ? memberRows : [];
          const formTitle = (!formRows?.error && formRows[0]?.title) || 'your team registration';
          if (members.length) {
            const now = new Date().toISOString();
            const verb = status === 'approved' ? 'approved' : 'rejected';
            const rows = members.map(m => ({
              user_id: 'student:' + m.student_id,
              type: 'group_form_review_' + status,
              title: `${status === 'approved' ? 'Approved' : 'Rejected'} — ${formTitle}`,
              message: `The authority has ${verb} your team's submission for "${formTitle}".`,
              data: { team_id: Number(team_id), group_form_id: groupFormId },
              is_read: false,
              created_at: now,
            }));
            await sb('notifications', 'POST', rows, { 'Accept-Profile': 'teacher_staff', 'Content-Profile': 'teacher_staff' });
          }
        }
      } catch (e) {
        console.error('set_team_review_status notification failed:', e);
      }
    }

    return NextResponse.json({ result: 'success' });
  }

  // ── Look up a student by ID (student-callable) ───────────────────────────
  // Same narrow allowlist as get_public_profile above, for the same reason:
  // a leader typing a teammate's ID should see enough to confirm it's the
  // right person (name, class, section) and nothing more sensitive.
  if (action === 'lookup_student_by_id') {
    const { student_id } = payload;
    if (!student_id) return NextResponse.json({ result: 'error', message: 'student_id required.' });
    const fields = 'student_id,student_name,class,section,roll';
    const rows = await sb(`students_data?student_id=eq.${encodeURIComponent(student_id)}&select=${fields}`);
    if (!rows?.error && rows.length) return NextResponse.json({ result: 'success', data: rows[0] });
    return NextResponse.json({ result: 'error', message: 'No student found with that ID.' });
  }

  // ── Search students by name/class/section/roll/ID (Group Forms teammate
  // picker) — same minimal field set and or=(...ilike...) pattern
  // search_edit_history already uses, just against students_data instead.
  if (action === 'search_students') {
    // house/session included (not just class/section/roll) so the teammate
    // picker can reject an ineligible pick client-side via
    // gfClientCheckEligibility, without a second round trip — same safe
    // field set get_public_profile already exposes. An eligibility rule
    // grouped by some OTHER column (admin can now pick any header) just
    // can't be previewed client-side and defers to the server's own check.
    const fields = 'student_id,student_name,class,section,roll,house,session';
    const { class: klass, section, name, roll } = payload || {};
    const structured = [klass, section, name, roll].some(v => String(v || '').trim());

    let path;
    if (structured) {
      // Advanced filter panel — every provided field is AND-ed together
      // (plain query params, not or=()), unlike the free-text q below.
      const parts = [`select=${fields}`];
      if (klass) parts.push(`class=eq.${encodeURIComponent(String(klass).trim())}`);
      if (section) parts.push(`section=eq.${encodeURIComponent(String(section).trim())}`);
      if (name) parts.push(`student_name=ilike.*${encodeURIComponent(String(name).trim())}*`);
      if (roll) parts.push(`roll=ilike.*${encodeURIComponent(String(roll).trim())}*`);
      parts.push('order=student_name.asc', 'limit=30');
      path = `students_data?${parts.join('&')}`;
    } else {
      const q = String(payload?.query || payload?.q || '').trim();
      if (q.length < 2) return NextResponse.json({ result: 'success', data: [] });
      const esc = encodeURIComponent(q);
      path = `students_data?select=${fields}&or=(student_id.ilike.*${esc}*,student_name.ilike.*${esc}*,class.ilike.*${esc}*,section.ilike.*${esc}*,roll.ilike.*${esc}*)&order=student_name.asc&limit=15`;
    }
    const rows = await sb(path);
    if (rows?.error) return NextResponse.json({ result: 'error', message: rows.error });
    return NextResponse.json({ result: 'success', data: Array.isArray(rows) ? rows : [] });
  }

  // ── My OMR exam results (published only — never trusts the client to
  // filter) ─────────────────────────────────────────────────────────────
  if (action === 'get_my_omr_results') {
    const { student_id } = payload;
    if (!student_id) return NextResponse.json({ result: 'error', message: 'student_id required.' });
    const resultRows = await sb(`omr_exam_results?student_id=eq.${encodeURIComponent(student_id)}&order=created_at.desc`);
    if (resultRows?.error) return NextResponse.json({ result: 'error', message: resultRows.error });
    const rows = Array.isArray(resultRows) ? resultRows : [];
    if (!rows.length) return NextResponse.json({ result: 'success', results: [] });
    const batchIds = [...new Set(rows.map(r => r.batch_id))];
    const batchRows = await sb(`omr_exam_batches?id=in.(${batchIds.join(',')})&is_published=eq.true`);
    if (batchRows?.error) return NextResponse.json({ result: 'error', message: batchRows.error });
    const batchById = {};
    (Array.isArray(batchRows) ? batchRows : []).forEach(b => { batchById[b.id] = b; });
    const results = rows.filter(r => batchById[r.batch_id]).map(r => ({ ...r, batch: batchById[r.batch_id] }));
    return NextResponse.json({ result: 'success', results });
  }

  // ── Get my team (or my pending invite) for one Group Form ───────────────
  if (action === 'get_my_team') {
    const { student_id, group_form_id } = payload;
    if (!student_id || !group_form_id) return NextResponse.json({ result: 'error', message: 'student_id and group_form_id required.' });

    const memberRow = await sb(`group_form_team_members?group_form_id=eq.${encodeURIComponent(group_form_id)}&student_id=eq.${encodeURIComponent(student_id)}`);
    if (memberRow?.error) return NextResponse.json({ result: 'error', message: memberRow.error });

    if (memberRow.length) {
      const teamId = memberRow[0].team_id;
      const [teamRows, allMembers, pendingInvites] = await Promise.all([
        sb(`group_form_teams?id=eq.${encodeURIComponent(teamId)}`),
        sb(`group_form_team_members?team_id=eq.${encodeURIComponent(teamId)}`),
        sb(`group_form_team_invites?team_id=eq.${encodeURIComponent(teamId)}&status=eq.pending`),
      ]);
      const team = (!teamRows?.error && teamRows[0]) ? teamRows[0] : null;
      if (!team) return NextResponse.json({ result: 'success', team: null, invite: null });
      const memberList = Array.isArray(allMembers) ? allMembers : [];
      const inviteList = Array.isArray(pendingInvites) ? pendingInvites : [];
      const ids = [...new Set([...memberList.map(m => m.student_id), ...inviteList.map(i => i.invited_student_id)])];
      const nameById = {};
      if (ids.length) {
        const profRows = await sb(`students_data?student_id=in.(${ids.map(encodeURIComponent).join(',')})&select=student_id,student_name,class,section,house,session`);
        (Array.isArray(profRows) ? profRows : []).forEach(p => { nameById[p.student_id] = p; });
      }
      return NextResponse.json({
        result: 'success',
        is_leader: team.leader_student_id === student_id,
        team: {
          ...team,
          members: memberList.map(m => ({ ...m, profile: nameById[m.student_id] || null })),
          pending_invites: inviteList.map(i => ({ ...i, profile: nameById[i.invited_student_id] || null })),
        },
        invite: null,
      });
    }

    const inviteRows = await sb(`group_form_team_invites?group_form_id=eq.${encodeURIComponent(group_form_id)}&invited_student_id=eq.${encodeURIComponent(student_id)}&status=eq.pending&order=created_at.desc`);
    if (!inviteRows?.error && inviteRows.length) {
      const invite = inviteRows[0];
      const leaderRows = await sb(`group_form_teams?id=eq.${encodeURIComponent(invite.team_id)}`);
      const leaderId = (!leaderRows?.error && leaderRows[0]) ? leaderRows[0].leader_student_id : null;
      let leaderProfile = null;
      if (leaderId) {
        const p = await sb(`students_data?student_id=eq.${encodeURIComponent(leaderId)}&select=student_id,student_name,class,section,house,session`);
        leaderProfile = (!p?.error && p[0]) ? p[0] : null;
      }
      return NextResponse.json({ result: 'success', team: null, invite: { ...invite, leader_profile: leaderProfile } });
    }

    return NextResponse.json({ result: 'success', team: null, invite: null });
  }

  // ── Create a team (become its leader) ────────────────────────────────────
  if (action === 'create_group') {
    const { student_id, group_form_id, group_data } = payload;
    if (!student_id || !group_form_id) return NextResponse.json({ result: 'error', message: 'student_id and group_form_id required.' });
    const formRows = await sb(`group_forms?id=eq.${encodeURIComponent(group_form_id)}`);
    const form = (!formRows?.error && formRows[0]) ? formRows[0] : null;
    if (!form) return NextResponse.json({ result: 'error', message: 'Group form not found.' });
    if (!form.is_enabled) return NextResponse.json({ result: 'error', message: 'This form is not available.' });

    // get_group_forms hides a form from the nav when its Logic Rules
    // (condition_json) don't match this student, but that's a nav filter
    // only -- it was never rechecked here, so a student with the direct
    // ?gf=<id> link (which the admin UI itself hands out as a QR code) could
    // still create a team the Logic Rules say they're not eligible for.
    //
    // accepting_condition_json is a SEPARATE, optional rule set for "who can
    // start a NEW team". When it has rules, it is AUTHORITATIVE over the
    // plain accepting_new switch -- in BOTH directions. That's what lets an
    // admin flip Open OFF (closed to everyone) while still listing a
    // specific student_id in the Filter to let just that student through,
    // e.g. a late registrant let in without reopening to everyone, same as
    // get_group_forms' accepting_eligible computation. No rules configured
    // (the default) falls back to the plain switch, same as before this
    // column existed.
    let condObj = null, acceptCondObj = null;
    try { condObj = JSON.parse(form.condition_json || '{}'); } catch {}
    try { acceptCondObj = JSON.parse(form.accepting_condition_json || '{}'); } catch {}
    const hasAcceptRules = !!(acceptCondObj && acceptCondObj.rules?.length);
    if ((condObj && condObj.rules?.length) || hasAcceptRules) {
      const profileRows = await sb(`students_data?student_id=eq.${encodeURIComponent(student_id)}&select=*`);
      const profile = (profileRows && !profileRows.error && profileRows[0]) ? profileRows[0] : { student_id };
      const subRows = await sb(`portal_submissions?student_id=eq.${encodeURIComponent(student_id)}&select=tab_name`);
      const submissions = subRows?.error ? [] : subRows;
      if (condObj && condObj.rules?.length) {
        const results = await Promise.all(condObj.rules.map(r => evalRule(r, profile, submissions)));
        const pass = condObj.logic === 'OR' ? results.some(Boolean) : results.every(Boolean);
        if (!pass) return NextResponse.json({ result: 'error', message: 'This form is not available for your profile.' });
      }
      if (hasAcceptRules) {
        const results = await Promise.all(acceptCondObj.rules.map(r => evalRule(r, profile, submissions)));
        const pass = acceptCondObj.logic === 'OR' ? results.some(Boolean) : results.every(Boolean);
        if (!pass) return NextResponse.json({ result: 'error', message: 'Registration is not open for your profile yet.' });
      }
    }
    if (!hasAcceptRules && !form.accepting_new) return NextResponse.json({ result: 'error', message: 'Registration is closed for new teams.' });

    if (!(await hasProfilePhoto(student_id))) {
      return NextResponse.json({ result: 'error', code: 'PHOTO_REQUIRED', message: 'Please upload a profile picture before creating a team.' });
    }

    const res = await sb('rpc/group_team_create', 'POST', { p_group_form_id: group_form_id, p_leader_id: student_id, p_group_data: group_data || {} });
    if (res?.error) return NextResponse.json({ result: 'error', message: rpcErrorMessage(res.error) });
    const team_id = res;

    let reference_number = null;
    try {
      const leaderRows = await sb(`students_data?student_id=eq.${encodeURIComponent(student_id)}&select=*`);
      const leaderProfile = (!leaderRows?.error && leaderRows[0]) ? leaderRows[0] : null;
      reference_number = await buildReferenceNumber(form.reference_number_json, form, leaderProfile, group_data);
      if (reference_number) await sb(`group_form_teams?id=eq.${encodeURIComponent(team_id)}`, 'PATCH', { reference_number });
    } catch (e) { /* team already exists either way — a reference-number hiccup is never fatal */ }

    return NextResponse.json({ result: 'success', team_id, reference_number });
  }

  // ── Backfill reference numbers onto existing teams (admin) ──────────────
  // For teams created/submitted before Reference Number was configured (or
  // before a config change), create_group's own best-effort assignment
  // never ran. Walks every Group Form with reference_number_json.enabled
  // (or just one, if group_form_id is given), finds its submitted teams
  // still missing one, and fills them in via the exact same buildReference
  // Number() + rpc/group_form_next_seq path create_group uses — so numbers
  // keep handing out in the same sequence a brand-new team would get next.
  // Processed one team at a time, oldest first, so the sequence stays
  // chronological instead of racing itself across parallel requests.
  if (action === 'backfill_reference_numbers') {
    const { group_form_id } = payload;
    const formsRes = group_form_id
      ? await sb(`group_forms?id=eq.${encodeURIComponent(group_form_id)}`)
      : await sb('group_forms');
    const allForms = Array.isArray(formsRes) ? formsRes : [];
    const forms = allForms.filter(f => {
      try { return !!(JSON.parse(f.reference_number_json || '{}') || {}).enabled; } catch (_) { return false; }
    });

    const results = [];
    for (const form of forms) {
      const teamsRes = await sb(`group_form_teams?group_form_id=eq.${encodeURIComponent(form.id)}&status=eq.active&is_submitted=eq.true&reference_number=is.null&order=created_at.asc`);
      const teams = Array.isArray(teamsRes) ? teamsRes : [];
      let updated = 0, skipped = 0;
      for (const team of teams) {
        try {
          const leaderRows = await sb(`students_data?student_id=eq.${encodeURIComponent(team.leader_student_id)}&select=*`);
          const leaderProfile = (!leaderRows?.error && leaderRows[0]) ? leaderRows[0] : null;
          const reference_number = await buildReferenceNumber(form.reference_number_json, form, leaderProfile, team.group_data);
          if (reference_number) {
            await sb(`group_form_teams?id=eq.${encodeURIComponent(team.id)}`, 'PATCH', { reference_number });
            updated++;
          } else {
            skipped++;
          }
        } catch (e) {
          skipped++;
        }
      }
      results.push({ group_form_id: form.id, title: form.title, candidates: teams.length, updated, skipped });
    }

    return NextResponse.json({ result: 'success', forms: results });
  }

  // ── Invite a teammate (leader only) ──────────────────────────────────────
  if (action === 'invite_to_group') {
    const { team_id, leader_id, invited_student_id } = payload;
    if (!team_id || !leader_id || !invited_student_id) return NextResponse.json({ result: 'error', message: 'team_id, leader_id and invited_student_id required.' });
    if (invited_student_id === leader_id) return NextResponse.json({ result: 'error', message: "You can't invite yourself." });

    const teamRows = await sb(`group_form_teams?id=eq.${encodeURIComponent(team_id)}`);
    const team = (!teamRows?.error && teamRows[0]) ? teamRows[0] : null;
    if (!team) return NextResponse.json({ result: 'error', message: 'Team not found.' });
    if (team.leader_student_id !== leader_id) return NextResponse.json({ result: 'error', message: 'Only the team leader can invite.' });
    if (team.status !== 'active') return NextResponse.json({ result: 'error', message: 'This team no longer exists.' });
    if (team.is_locked) return NextResponse.json({ result: 'error', message: 'This team is locked by the admin.' });
    if (team.is_submitted) return NextResponse.json({ result: 'error', message: 'This team has already been submitted and can no longer be changed.' });

    const [formRows, memberRows, existingMember, lookup, leaderRows] = await Promise.all([
      sb(`group_forms?id=eq.${encodeURIComponent(team.group_form_id)}`),
      sb(`group_form_team_members?team_id=eq.${encodeURIComponent(team_id)}`),
      sb(`group_form_team_members?group_form_id=eq.${encodeURIComponent(team.group_form_id)}&student_id=eq.${encodeURIComponent(invited_student_id)}`),
      // Full row (server-only — never sent to the client verbatim, only fed
      // into checkGroupEligibility's ok/reason result) since eligibility_json
      // can now group by ANY students_data column, not just class/section/house.
      sb(`students_data?student_id=eq.${encodeURIComponent(invited_student_id)}&select=*`),
      sb(`students_data?student_id=eq.${encodeURIComponent(leader_id)}&select=*`),
    ]);
    const form = (!formRows?.error && formRows[0]) ? formRows[0] : null;
    if (!form) return NextResponse.json({ result: 'error', message: 'Group form not found.' });
    const currentCount = Array.isArray(memberRows) ? memberRows.length : 0;
    if (currentCount >= form.max_team_size) return NextResponse.json({ result: 'error', message: 'This team is already full.' });
    if (!existingMember?.error && existingMember.length) return NextResponse.json({ result: 'error', message: 'This student is already in a team for this form.' });
    if (lookup?.error || !lookup.length) return NextResponse.json({ result: 'error', message: 'No student found with that ID.' });

    const leaderProfile = (!leaderRows?.error && leaderRows[0]) ? leaderRows[0] : {};
    const eligibility = checkGroupEligibility(form.eligibility_json, leaderProfile, lookup[0]);
    if (!eligibility.ok) return NextResponse.json({ result: 'error', message: `This student ${eligibility.reason} for this form.` });

    const r = await sb(
      'group_form_team_invites?on_conflict=team_id,invited_student_id', 'POST',
      { group_form_id: team.group_form_id, team_id, invited_by: leader_id, invited_student_id, status: 'pending', responded_at: null },
      { Prefer: 'resolution=merge-duplicates,return=representation' }
    );
    if (r?.error) return NextResponse.json({ result: 'error', message: 'Could not send the invite: ' + r.error });
    return NextResponse.json({ result: 'success' });
  }

  // ── Cancel a pending invite (leader only) ────────────────────────────────
  if (action === 'cancel_invite') {
    const { invite_id, leader_id } = payload;
    if (!invite_id || !leader_id) return NextResponse.json({ result: 'error', message: 'invite_id and leader_id required.' });
    const rows = await sb(`group_form_team_invites?id=eq.${encodeURIComponent(invite_id)}`);
    const invite = (!rows?.error && rows[0]) ? rows[0] : null;
    if (!invite) return NextResponse.json({ result: 'error', message: 'Invite not found.' });
    if (invite.invited_by !== leader_id) return NextResponse.json({ result: 'error', message: 'Only the inviting leader can cancel this.' });
    if (invite.status !== 'pending') return NextResponse.json({ result: 'error', message: 'This invite has already been answered.' });
    const r = await sb(`group_form_team_invites?id=eq.${encodeURIComponent(invite_id)}`, 'PATCH', { status: 'cancelled', responded_at: new Date().toISOString() });
    if (r?.error) return NextResponse.json({ result: 'error', message: r.error });
    return NextResponse.json({ result: 'success' });
  }

  // ── Accept or decline an invite ──────────────────────────────────────────
  if (action === 'respond_to_invite') {
    const { invite_id, student_id, accept } = payload;
    if (!invite_id || !student_id) return NextResponse.json({ result: 'error', message: 'invite_id and student_id required.' });

    if (!accept) {
      const rows = await sb(`group_form_team_invites?id=eq.${encodeURIComponent(invite_id)}`);
      const invite = (!rows?.error && rows[0]) ? rows[0] : null;
      if (!invite) return NextResponse.json({ result: 'error', message: 'Invite not found.' });
      if (invite.invited_student_id !== student_id) return NextResponse.json({ result: 'error', message: 'This is not your invite.' });
      if (invite.status !== 'pending') return NextResponse.json({ result: 'error', message: 'This invite has already been answered.' });
      const r = await sb(`group_form_team_invites?id=eq.${encodeURIComponent(invite_id)}`, 'PATCH', { status: 'declined', responded_at: new Date().toISOString() });
      if (r?.error) return NextResponse.json({ result: 'error', message: r.error });
      return NextResponse.json({ result: 'success' });
    }

    if (!(await hasProfilePhoto(student_id))) {
      return NextResponse.json({ result: 'error', code: 'PHOTO_REQUIRED', message: 'Please upload a profile picture before accepting this invite.' });
    }
    const res = await sb('rpc/group_team_accept_invite', 'POST', { p_invite_id: invite_id, p_student_id: student_id });
    if (res?.error) return NextResponse.json({ result: 'error', message: rpcErrorMessage(res.error) });
    const inviteRows = await sb(`group_form_team_invites?id=eq.${encodeURIComponent(invite_id)}&select=team_id`);
    const acceptedTeamId = (!inviteRows?.error && inviteRows[0]) ? inviteRows[0].team_id : null;
    if (acceptedTeamId) await _maybeAutoSubmitTeam(acceptedTeamId);
    return NextResponse.json({ result: 'success' });
  }

  // ── Leave a team (self) or remove a member (leader) ──────────────────────
  // One action serves both: actor_id must be either the member themselves or
  // the team's leader. The leader can't leave this way — they disband instead
  // (disband_group), since removing "themselves" would orphan the team.
  if (action === 'leave_group') {
    const { team_id, student_id, actor_id } = payload;
    if (!team_id || !student_id || !actor_id) return NextResponse.json({ result: 'error', message: 'team_id, student_id and actor_id required.' });
    const teamRows = await sb(`group_form_teams?id=eq.${encodeURIComponent(team_id)}`);
    const team = (!teamRows?.error && teamRows[0]) ? teamRows[0] : null;
    if (!team) return NextResponse.json({ result: 'error', message: 'Team not found.' });
    if (actor_id !== student_id && actor_id !== team.leader_student_id) return NextResponse.json({ result: 'error', message: 'Not allowed.' });
    if (team.is_locked) return NextResponse.json({ result: 'error', message: 'This team is locked by the admin.' });
    if (team.is_submitted) return NextResponse.json({ result: 'error', message: 'This team has already been submitted and can no longer be changed.' });
    if (student_id === team.leader_student_id) return NextResponse.json({ result: 'error', message: 'The leader cannot leave — disband the team instead.' });

    const r = await sb(`group_form_team_members?team_id=eq.${encodeURIComponent(team_id)}&student_id=eq.${encodeURIComponent(student_id)}`, 'DELETE');
    if (r?.error) return NextResponse.json({ result: 'error', message: r.error });
    return NextResponse.json({ result: 'success' });
  }

  // ── Disband a team (leader only) ─────────────────────────────────────────
  // Removes every member (freeing them to join elsewhere) but keeps the team
  // row itself, marked 'disbanded', for history — never hard-deleted.
  if (action === 'disband_group') {
    const { team_id, leader_id } = payload;
    if (!team_id || !leader_id) return NextResponse.json({ result: 'error', message: 'team_id and leader_id required.' });
    const teamRows = await sb(`group_form_teams?id=eq.${encodeURIComponent(team_id)}`);
    const team = (!teamRows?.error && teamRows[0]) ? teamRows[0] : null;
    if (!team) return NextResponse.json({ result: 'error', message: 'Team not found.' });
    if (team.leader_student_id !== leader_id) return NextResponse.json({ result: 'error', message: 'Only the team leader can disband this team.' });
    if (team.is_locked) return NextResponse.json({ result: 'error', message: 'This team is locked by the admin.' });
    if (team.is_submitted) return NextResponse.json({ result: 'error', message: 'This team has already been submitted — contact the admin if it needs to be withdrawn.' });

    await sb(`group_form_team_invites?team_id=eq.${encodeURIComponent(team_id)}&status=eq.pending`, 'PATCH', { status: 'cancelled', responded_at: new Date().toISOString() });
    await sb(`group_form_team_members?team_id=eq.${encodeURIComponent(team_id)}`, 'DELETE');
    const r = await sb(`group_form_teams?id=eq.${encodeURIComponent(team_id)}`, 'PATCH', { status: 'disbanded', updated_at: new Date().toISOString() });
    if (r?.error) return NextResponse.json({ result: 'error', message: r.error });
    return NextResponse.json({ result: 'success' });
  }

  // ── Edit the team's own field answers (leader only) ──────────────────────
  if (action === 'update_group_data') {
    const { team_id, leader_id, group_data } = payload;
    if (!team_id || !leader_id) return NextResponse.json({ result: 'error', message: 'team_id and leader_id required.' });
    const teamRows = await sb(`group_form_teams?id=eq.${encodeURIComponent(team_id)}`);
    const team = (!teamRows?.error && teamRows[0]) ? teamRows[0] : null;
    if (!team) return NextResponse.json({ result: 'error', message: 'Team not found.' });
    if (team.leader_student_id !== leader_id) return NextResponse.json({ result: 'error', message: 'Only the team leader can edit these details.' });
    if (team.is_locked) return NextResponse.json({ result: 'error', message: 'This team is locked by the admin.' });
    if (team.is_submitted) return NextResponse.json({ result: 'error', message: 'This team has already been submitted and can no longer be changed.' });
    const r = await sb(`group_form_teams?id=eq.${encodeURIComponent(team_id)}`, 'PATCH', { group_data: group_data || {}, updated_at: new Date().toISOString() });
    if (r?.error) return NextResponse.json({ result: 'error', message: r.error });
    return NextResponse.json({ result: 'success' });
  }

  // ── Submit a team (leader only) — the final step after "saving" details ───
  // Requires: no pending invites left unanswered, the team full if the form
  // marks members_required, and every current member (leader included) has a
  // profile picture on file. Once set, is_submitted freezes the team exactly
  // like admin-set is_locked already does (see the checks added above), so
  // the admin's roster can tell a finished submission apart from a draft.
  if (action === 'submit_group_team') {
    const { team_id, leader_id } = payload;
    if (!team_id || !leader_id) return NextResponse.json({ result: 'error', message: 'team_id and leader_id required.' });
    const teamRows = await sb(`group_form_teams?id=eq.${encodeURIComponent(team_id)}`);
    const team = (!teamRows?.error && teamRows[0]) ? teamRows[0] : null;
    if (!team) return NextResponse.json({ result: 'error', message: 'Team not found.' });
    if (team.leader_student_id !== leader_id) return NextResponse.json({ result: 'error', message: 'Only the team leader can submit this team.' });
    if (team.status !== 'active') return NextResponse.json({ result: 'error', message: 'This team no longer exists.' });
    if (team.is_locked) return NextResponse.json({ result: 'error', message: 'This team is locked by the admin.' });
    if (team.is_submitted) return NextResponse.json({ result: 'error', message: 'This team has already been submitted.' });

    const [formRows, memberRows, pendingRows] = await Promise.all([
      sb(`group_forms?id=eq.${encodeURIComponent(team.group_form_id)}`),
      sb(`group_form_team_members?team_id=eq.${encodeURIComponent(team_id)}`),
      sb(`group_form_team_invites?team_id=eq.${encodeURIComponent(team_id)}&status=eq.pending`),
    ]);
    const form = (!formRows?.error && formRows[0]) ? formRows[0] : null;
    if (!form) return NextResponse.json({ result: 'error', message: 'Group form not found.' });
    const members = Array.isArray(memberRows) ? memberRows : [];
    const pending = Array.isArray(pendingRows) ? pendingRows : [];

    if (pending.length) {
      return NextResponse.json({ result: 'error', message: `You still have ${pending.length} pending invite${pending.length === 1 ? '' : 's'} — wait for everyone to respond before submitting.` });
    }
    if (form.members_required && members.length < form.max_team_size) {
      return NextResponse.json({ result: 'error', message: `This form requires a full team of ${form.max_team_size} before you can submit.` });
    }
    const missingFields = missingRequiredFields(form.fields_json, team.group_data);
    if (missingFields.length) {
      return NextResponse.json({ result: 'error', message: `Fill in required field${missingFields.length === 1 ? '' : 's'}: ${missingFields.join(', ')}.` });
    }

    const photoChecks = await Promise.all(members.map(m => hasProfilePhoto(m.student_id)));
    const missingCount = photoChecks.filter(ok => !ok).length;
    if (missingCount) {
      return NextResponse.json({ result: 'error', code: 'PHOTO_REQUIRED', message: `${missingCount === 1 ? 'One teammate still needs' : missingCount + ' teammates still need'} to upload a profile picture before you can submit.` });
    }

    const r = await sb(`group_form_teams?id=eq.${encodeURIComponent(team_id)}`, 'PATCH', {
      is_submitted: true, submitted_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      revision_comment: null, revision_requested_at: null, revision_requested_by: null, revision_requested_by_name: null,
    });
    if (r?.error) return NextResponse.json({ result: 'error', message: r.error });

    // create_group only ever gets one shot at a reference number, computed
    // from whatever group_data existed at team-creation time — usually
    // empty, since the leader fills in answers (Category, etc.) afterward
    // via update_group_data. Retry here, now that submission requires every
    // answer to actually be filled in — this is what actually gives most
    // teams their real reference number, not creation time. Best-effort,
    // never blocks a submission that already succeeded above.
    try {
      if (!team.reference_number) {
        const leaderRows = await sb(`students_data?student_id=eq.${encodeURIComponent(leader_id)}&select=*`);
        const leaderProfile = (!leaderRows?.error && leaderRows[0]) ? leaderRows[0] : null;
        const reference_number = await buildReferenceNumber(form.reference_number_json, form, leaderProfile, team.group_data);
        if (reference_number) await sb(`group_form_teams?id=eq.${encodeURIComponent(team_id)}`, 'PATCH', { reference_number });
      }
    } catch (e) {
      console.error('submit_group_team reference-number assignment failed:', e);
    }

    // Let the teacher who asked for changes know the leader acted on it.
    // revision_requested_by is a real teacher_staff.app_users user_id when
    // the request came from ccpc-teachers (admin or reviewer); it's the
    // literal 'admin' when it came from ccpc-students' own shared admin
    // login, which has no individual identity to notify — skip that case.
    // Best-effort: never let a notification failure block the submission
    // that already succeeded above.
    try {
      if (team.revision_requested_by && team.revision_requested_by !== 'admin') {
        const leaderRows = await sb(`students_data?student_id=eq.${encodeURIComponent(leader_id)}&select=student_name`);
        const leaderName = (!leaderRows?.error && leaderRows[0]?.student_name) || leader_id;
        await sb('notifications', 'POST', [{
          user_id: team.revision_requested_by,
          type: 'group_form_resubmitted',
          title: `Team resubmitted — ${form.title}`,
          message: `${leaderName} resubmitted their team after your requested changes.`,
          data: { team_id: Number(team_id), group_form_id: team.group_form_id },
          is_read: false,
          created_at: new Date().toISOString(),
        }], { 'Accept-Profile': 'teacher_staff', 'Content-Profile': 'teacher_staff' });
      }
    } catch (e) {
      console.error('submit_group_team notify requester failed:', e);
    }

    return NextResponse.json({ result: 'success' });
  }

  // ── Login Password Columns (which students_data phone-like columns are
  // accepted as the login password) ────────────────────────────────────────
  if (action === 'get_login_password_columns') {
    const rows = await sb('portal_settings?key=eq.login_password_columns');
    const saved = (!rows?.error && rows[0]) ? rows[0].value : null;
    // Never configured yet -> every candidate is allowed, matching the
    // original hardcoded auto-detect-by-name behavior so nothing breaks
    // for a school that hasn't touched this setting.
    const selected = Array.isArray(saved) ? saved.filter(c => LOGIN_PASSWORD_CANDIDATES.includes(c)) : LOGIN_PASSWORD_CANDIDATES;
    return NextResponse.json({ candidates: LOGIN_PASSWORD_CANDIDATES, selected });
  }
  if (action === 'set_login_password_columns') {
    const columns = Array.isArray(payload?.columns) ? payload.columns.filter(c => LOGIN_PASSWORD_CANDIDATES.includes(c)) : [];
    if (!columns.length) return NextResponse.json({ result: 'error', message: 'Select at least one column — otherwise no student could log in.' });
    const r = await psSave('login_password_columns', columns);
    if (!r.ok) return NextResponse.json({ result: 'error', message: r.message });
    return NextResponse.json({ result: 'success' });
  }

  // ── Student PIN (self-service, set from the student's own Personal Hub) ────
  // Empty pin clears it, dropping the account back to admin-selected-column
  // login — matches "if pin field is empty then login falls back automatically."
  if (action === 'set_student_pin') {
    const { student_id, pin } = payload;
    if (!student_id || student_id === 'admin') return NextResponse.json({ result: 'error', message: 'Invalid request.' });
    const cleanPin = String(pin || '').trim();
    if (cleanPin && !/^\d{4,6}$/.test(cleanPin)) {
      return NextResponse.json({ result: 'error', message: 'PIN must be 4 to 6 digits.' });
    }
    const r = await sb(`students_data?student_id=eq.${encodeURIComponent(student_id)}`, 'PATCH', { pin: cleanPin || null });
    if (r?.error) return NextResponse.json({ result: 'error', message: 'Could not update PIN.' });
    return NextResponse.json({ result: 'success', pinSet: !!cleanPin });
  }

  // ── Forgot PIN — self-service reset via the same admin-selected-column
  // verification the old phone-based login used, so it works as an identity
  // check independent of whatever PIN is currently set. ──────────────────────
  if (action === 'reset_pin') {
    const { student_id, phone_number } = payload;
    if (!student_id || !phone_number) return NextResponse.json({ result: 'error', message: 'Student ID and phone number required.' });
    const rows = await sb(`students_data?student_id=eq.${encodeURIComponent(student_id)}&select=*`);
    if (rows?.error) return NextResponse.json({ result: 'error', message: 'Database error.' });
    if (!rows.length) return NextResponse.json({ result: 'error', message: 'Student ID not found.' });

    const { matches } = await verifyAdminSelectedPassword(rows[0], phone_number);
    if (!matches) return NextResponse.json({ result: 'error', message: 'Could not verify your identity with that phone number.' });

    const r = await sb(`students_data?student_id=eq.${encodeURIComponent(student_id)}`, 'PATCH', { pin: null });
    if (r?.error) return NextResponse.json({ result: 'error', message: 'Could not reset PIN.' });
    return NextResponse.json({ result: 'success', message: 'PIN cleared. You can now log in with your phone number.' });
  }

  // ── Admin-triggered PIN reset (no phone verification — admin is already
  // authenticated) — for when a student is locked out and can't reach their
  // own registered phone number to use the self-service reset above. ────────
  if (action === 'admin_reset_pin') {
    const { student_id } = payload;
    if (!student_id) return NextResponse.json({ result: 'error', message: 'Student ID required.' });
    const rows = await sb(`students_data?student_id=eq.${encodeURIComponent(student_id)}&select=student_id`);
    if (rows?.error) return NextResponse.json({ result: 'error', message: 'Database error.' });
    if (!rows.length) return NextResponse.json({ result: 'error', message: 'Student ID not found.' });
    const r = await sb(`students_data?student_id=eq.${encodeURIComponent(student_id)}`, 'PATCH', { pin: null });
    if (r?.error) return NextResponse.json({ result: 'error', message: 'Could not reset PIN.' });
    return NextResponse.json({ result: 'success', message: `PIN cleared for ${student_id} — they can log in with their phone number again.` });
  }

  // ── Edit History (admin-searchable audit trail, populated by a DB trigger
  // on every students_data UPDATE — see the edit_history table) ──────────────
  // Paginated server-side (offset/limit) rather than a single capped fetch —
  // the log grows unbounded, so a flat limit=200 silently hid everything
  // past it with no way to reach it. The `or=(...ilike...)` filter always
  // ran against the full table regardless (PostgREST, not a client-side
  // filter), so search already covered everything — it just couldn't show
  // more than the first page of matches. Prefer: count=exact + the
  // Content-Range response header give the true total so the UI can render
  // real page numbers instead of guessing whether more rows exist.
  if (action === 'search_edit_history') {
    const q = String(payload?.query || '').trim();
    const limit = Math.min(Math.max(Number(payload?.limit) || 50, 1), 100);
    const offset = Math.max(Number(payload?.offset) || 0, 0);
    let path = `edit_history?select=*&order=created_at.desc&limit=${limit}&offset=${offset}`;
    if (q) {
      const esc = encodeURIComponent(q);
      path += `&or=(student_id.ilike.*${esc}*,name.ilike.*${esc}*,class.ilike.*${esc}*,section.ilike.*${esc}*,roll.ilike.*${esc}*)`;
    }
    const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        'Accept-Profile': 'student',
        Prefer: 'count=exact',
      },
    });
    const text = await res.text();
    if (!res.ok) return NextResponse.json({ result: 'error', message: text });
    const rows = text ? JSON.parse(text) : [];
    const total = Number((res.headers.get('content-range') || '').split('/')[1]) || rows.length;
    return NextResponse.json({ result: 'success', rows, total, offset, limit });
  }

  // ── Permanent Tabs Visibility (Wallet/Canteen/Stationary/Teachers/Bus — the
  // built-in tabs, not the tab-builder's custom ones in portal_tabs) ──────────
  // Missing key or missing per-tab entry both mean "visible" — a fresh install
  // or a newly-added permanent tab should show up, not silently vanish.
  if (action === 'get_permanent_tabs_config') {
    const rows = await sb('portal_settings?key=eq.permanent_tabs_visibility');
    const cfg = (!rows?.error && rows[0]) ? rows[0].value : {};
    return NextResponse.json(cfg || {});
  }
  if (action === 'set_permanent_tabs_config') {
    const cfg = (payload && typeof payload === 'object') ? payload : {};
    const r = await psSave('permanent_tabs_visibility', cfg);
    if (!r.ok) return NextResponse.json({ result: 'error', message: r.message });
    return NextResponse.json({ result: 'success' });
  }

  // ── Get Tracking Config ───────────────────────────────────────────────────
  if (action === 'get_tracking_config') {
    const rows = await sb('portal_settings?key=in.(bus_registry,place_registry,gp_credentials)');
    if (rows?.error) return NextResponse.json({});
    const map = {};
    rows.forEach(r => { map[r.key] = r.value; });
    const creds = map.gp_credentials || {};
    return NextResponse.json({
      busRegistry:   (map.bus_registry   || []).map(r => [r.name, r.imei]),
      placeRegistry: (map.place_registry || []).map(r => [r.name, r.coords, r.radius]),
      credentials:   { username: creds.username || '', password: creds.password ? '********' : '', environment: creds.environment || 'production', apiKey: creds.api_key || '' },
    });
  }

  // ── Save Bus Registry ─────────────────────────────────────────────────────
  if (action === 'save_bus_registry') {
    const value = (payload.rows || []).map(r => ({ name: r[0], imei: r[1] }));
    const r = await psSave('bus_registry', value);
    if (!r.ok) return NextResponse.json({ result: 'error', message: r.message });
    return NextResponse.json({ result: 'success' });
  }

  // ── Save Place Registry ───────────────────────────────────────────────────
  if (action === 'save_place_registry') {
    const value = (payload.rows || []).map(r => ({ name: r[0], coords: r[1], radius: r[2] }));
    const r = await psSave('place_registry', value);
    if (!r.ok) return NextResponse.json({ result: 'error', message: r.message });
    return NextResponse.json({ result: 'success' });
  }

  // ── Set GP Credentials ────────────────────────────────────────────────────
  if (action === 'set_gp_credentials') {
    const { username, password, channel, environment, apiKey } = payload;
    const existing = await sb('portal_settings?key=eq.gp_credentials');
    const prevPass = (!existing?.error && existing[0]) ? existing[0].value?.password || '' : '';
    const pass = (password === '********' || !password) ? prevPass : password;
    const api_key = apiKey || (username && pass ? btoa(`${username}:${pass}`) : '');
    const value = { username, password: pass, channel: channel || 'ALOEXT', environment: environment || 'production', api_key };
    const r = await psSave('gp_credentials', value);
    if (!r.ok) return NextResponse.json({ result: 'error', message: r.message });
    return NextResponse.json({ result: 'success', message: `Credentials updated. Environment: ${(environment || 'production').toUpperCase()}` });
  }

  // ── Test GP Connection ────────────────────────────────────────────────────
  if (action === 'test_gp_connection') {
    try {
      const rows = await sb('portal_settings?key=eq.gp_credentials');
      const settings = (!rows?.error && rows[0]) ? rows[0].value : {};
      const { token, baseUrl } = await getGPToken(settings);
      return NextResponse.json({ result: 'success', message: 'Connection verified. Token received.' });
    } catch (e) {
      return NextResponse.json({ result: 'error', message: e.message });
    }
  }

  // ── Check Single Bus ──────────────────────────────────────────────────────
  if (action === 'check_bus') {
    try {
      const rows = await sb('portal_settings?key=eq.gp_credentials');
      const settings = (!rows?.error && rows[0]) ? rows[0].value : {};
      const items = await queryGPLocations(settings, [String(payload.imei)]);
      const d = items[0];
      if (d && (d.latitude || d.longitude)) {
        return NextResponse.json({ result: 'success', data: { address: d.address || 'Unknown', speed: d.speed || 0, engine: d.engineStatus ? 'ON' : 'OFF', time: d.locationTime || '' } });
      }
      return NextResponse.json({ result: 'error', message: d ? 'Device found but has no location fix yet.' : 'No data returned for this IMEI.' });
    } catch (e) {
      return NextResponse.json({ result: 'error', message: e.message });
    }
  }

  // ── Get All Bus Data (live tracker polling) ───────────────────────────────
  if (action === 'get_bus_data') {
    try {
      const [{ count: trackers, watchers }, rows] = await Promise.all([
        _trackPresence(payload.tracker_id, payload.label),
        sb('portal_settings?key=in.(gp_credentials,bus_registry)'),
      ]);
      if (rows?.error) return NextResponse.json({ result: 'error', message: 'Settings not found.' });
      const sm = {};
      rows.forEach(r => { sm[r.key] = r.value; });
      const creds = sm.gp_credentials || {};
      const busRegistry = sm.bus_registry || [];
      if (!busRegistry.length) return NextResponse.json({ result: 'success', data: [], trackers, watchers, dataAge: 0 });

      const items = await _getCachedBusLocations(creds, busRegistry.map(b => String(b.imei)));
      const dataMap = {};
      items.forEach(d => { dataMap[d.imei] = d; });

      const buses = busRegistry.map(b => {
        const d = dataMap[b.imei] || {};
        const spd = parseFloat(d.speed || 0);
        return {
          name: b.name, imei: b.imei,
          lat: parseFloat(d.latitude || 0),
          lng: parseFloat(d.longitude || 0),
          speed: String(spd), isMoving: spd > 2,
          engine: !!d.engineStatus,
          address: d.address || 'Unknown location',
          time: d.locationTime || '',
          heading: d.heading || 0,
        };
      });

      return NextResponse.json({ result: 'success', data: buses, trackers, watchers, dataAge: 0 });
    } catch (e) {
      return NextResponse.json({ result: 'error', message: e.message });
    }
  }

  // ── Get Teacher Directory (from teacher schema users_profile) ───────────────
  if (action === 'get_teacher_directory') {
    const fields = 'teacher_id,full_name,name_bengali,designation,department,category,phone,mobile,whatsapp,email,personal_email,blood_group,photo_url,gender';
    const rows = await sb(
      `users_profile?select=${fields}&order=full_name.asc`,
      'GET', null,
      { 'Accept-Profile': 'teacher_staff', 'Content-Profile': 'teacher_staff' }
    );
    if (rows?.error) return NextResponse.json([]);

    // Try to enrich with schedule from the live routine sheet ("Selected" tab,
    // ROUTINE_GID) — keyed by shortcode there, so resolve each teacher's own
    // shortcode via the "Logged in info" cross-reference before looking up.
    let scheduleMap = {};
    let shortNameMap = { byShort: {}, byFull: {} };
    try {
      const sheetRes = await fetch(
        `https://docs.google.com/spreadsheets/d/${ROUTINE_SHEET_ID}/export?format=csv&gid=${ROUTINE_GID}`,
        { signal: AbortSignal.timeout(6000) }
      );
      if (sheetRes.ok) scheduleMap = parseSheetSchedule(await sheetRes.text());
      shortNameMap = await getShortNameMap();
    } catch(_) { /* schedule is optional */ }

    return NextResponse.json((rows || [])
      .filter(t => t.full_name && t.category !== 'Non-Teaching')
      .map(t => {
        const shortcode = shortNameMap.byFull[t.full_name];
        return {
          teacher_id: t.teacher_id,
          name: t.full_name,
          name_bengali: t.name_bengali || '',
          designation: t.designation || '',
          department: t.department || '',
          category: t.category || '',
          phone: t.phone || t.mobile || '',
          whatsapp: t.whatsapp || '',
          email: t.email || t.personal_email || '',
          blood_group: t.blood_group || '',
          photo: t.photo_url || '',
          gender: t.gender || '',
          schedule: (shortcode && scheduleMap[shortcode]) || [],
        };
      }));
  }

  // ── Get Class Routine ─────────────────────────────────────────────────────
  // Default: scan "Selected" — the school's current live/adjusted day (its
  // own D1/F1 cells say which weekday+date that actually is; surfaced as
  // `meta` since "Selected" only advances when staff run Setup New Day, so it
  // can legitimately be stale — better to show the real date than pretend).
  // If `weekday` is passed instead: scan "Classes" (every weekday, no
  // adjustments) for that weekday's row — lets a student look at any day's
  // general schedule regardless of whether "Selected" has been refreshed.
  if (action === 'get_class_routine') {
    const { class_name, section, weekday } = payload;
    if (!class_name) return NextResponse.json({ result: 'error', message: 'class_name required.' });
    try {
      const fetched = await _fetchRoutineRows(weekday);
      if (fetched.error) return NextResponse.json({ result: 'error', message: fetched.error });
      const det = _detectRoutineHeader(fetched.rows);
      if (!det) return NextResponse.json({ result: 'error', message: 'Could not read the routine sheet header.' });
      const dataRows = _filterByWeekday(det.dataRows, det.headers, weekday);

      // Build every accepted spelling of the student's class+section — the
      // sheet mixes Roman numerals (VI, X), Arabic (6, 10) and English words
      // (Six, Ten) across different grades, with or without a hyphen.
      const romanMap = { '1':'I','2':'II','3':'III','4':'IV','5':'V','6':'VI','7':'VII','8':'VIII','9':'IX','10':'X' };
      const englishMap = { '1':'one','2':'two','3':'three','4':'four','5':'five','6':'six','7':'seven','8':'eight','9':'nine','10':'ten' };
      const arabicMap = Object.fromEntries(Object.entries(romanMap).map(([k,v]) => [v,k]));
      const englishToArabic = Object.fromEntries(Object.entries(englishMap).map(([k,v]) => [v,k]));
      const clean = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

      const possibleKeys = new Set([clean(`${class_name}-${section}`), clean(`${class_name}${section}`)]);
      let arabicBase = null;
      if (romanMap[class_name]) arabicBase = class_name;
      else if (arabicMap[class_name.toUpperCase()]) arabicBase = arabicMap[class_name.toUpperCase()];
      else if (englishToArabic[class_name.toLowerCase()]) arabicBase = englishToArabic[class_name.toLowerCase()];
      if (arabicBase) {
        [arabicBase, romanMap[arabicBase], englishMap[arabicBase]].forEach(fmt => {
          if (fmt) { possibleKeys.add(clean(`${fmt}-${section}`)); possibleKeys.add(clean(`${fmt}${section}`)); }
        });
      }

      const shortNameMap = await getShortNameMap();
      const routine = { '1st': null, '2nd': null, '3rd': null, '4th/Jr': null, '4th/Sr': null, '5th': null, '6th': null, '7th': null };

      for (const row of dataRows) {
        const rowTeacher = String(row[det.nameCol] || '').trim();
        if (!rowTeacher) continue;
        for (let i = det.firstPeriodIdx; i < det.headers.length; i++) {
          const cell = String(row[i] || '').trim();
          if (!cell) continue;
          const parts = _splitRoutineCell(cell);
          if (!parts || !possibleKeys.has(clean(parts[0]))) continue;

          const periodKey = _periodKeyFor(det.headers[i]);
          if (!(periodKey in routine) || routine[periodKey]) continue; // first match wins

          const { subject, originalShort } = _extractAdjustment((parts[1] || parts[0]).trim());
          routine[periodKey] = {
            subject,
            teacher: shortNameMap.byShort[rowTeacher] || rowTeacher,
            originalTeacher: originalShort ? (shortNameMap.byShort[originalShort] || originalShort) : (shortNameMap.byShort[rowTeacher] || rowTeacher),
            isAdjusted: !!originalShort,
          };
        }
      }

      return NextResponse.json({ result: 'success', routine, meta: fetched.meta });
    } catch (e) {
      return NextResponse.json({ result: 'error', message: 'Routine lookup failed: ' + e.message });
    }
  }

  // ── Get Teacher Schedule (personal routine, shown from their profile) ──────
  // Same dual-source model as get_class_routine: default = "Selected" (today,
  // with adjustments; meta says which day it actually is), or `weekday` =
  // "Classes" (that weekday's general schedule, every class this teacher has).
  if (action === 'get_teacher_schedule') {
    const { name, weekday } = payload;
    if (!name) return NextResponse.json({ result: 'error', message: 'name required.' });
    try {
      const shortNameMap = await getShortNameMap();
      const shortcode = shortNameMap.byFull[name];

      const fetched = await _fetchRoutineRows(weekday);
      if (fetched.error) return NextResponse.json({ result: 'error', message: fetched.error });
      const det = _detectRoutineHeader(fetched.rows);
      if (!det) return NextResponse.json({ result: 'error', message: 'Could not read the routine sheet header.' });
      const dataRows = _filterByWeekday(det.dataRows, det.headers, weekday);

      const schedule = [];
      if (shortcode) {
        const row = dataRows.find(r => String(r[det.nameCol] || '').trim() === shortcode);
        if (row) {
          for (let i = det.firstPeriodIdx; i < det.headers.length; i++) {
            const cell = String(row[i] || '').trim();
            if (!cell) continue;
            const parts = _splitRoutineCell(cell);
            if (!parts) continue;
            const { subject } = _extractAdjustment((parts[1] || parts[0]).trim());
            schedule.push({ period: _periodKeyFor(det.headers[i]), class: parts[0].trim(), subject });
          }
        }
      }

      return NextResponse.json({ result: 'success', schedule, meta: fetched.meta, resolved: !!shortcode });
    } catch (e) {
      return NextResponse.json({ result: 'error', message: 'Schedule lookup failed: ' + e.message });
    }
  }

  // ── Active Announcements (read-only feed) ───────────────────────────────
  // public.announcements is the same table ccpc-teachers' Announcements
  // module writes to — sb() defaults to the student schema, so this one
  // call needs the public-schema override, same technique
  // _resolveAuthorNames already uses above for `teacher`.
  //
  // Three announcement_type values live in this table: 'general' (shown to
  // every student, rendered as a carousel by announcements-feed.js —
  // never has audio), 'student' (shown only to the one student it names),
  // and 'device' (a class's P10 speaker broadcast — never reaches the
  // student portal at all, on purpose: it plays over campus speakers, it
  // isn't a message for guardians to read). target_student_id is stripped
  // before returning so a guardian's own feed never reveals another
  // student's id.
  if (action === 'get_active_announcements') {
    const { student_id } = payload;
    const rows = await sb('announcements?active=eq.true&select=id,announcement_type,title,subtitle,body,file_url,created_at,target_student_id&order=created_at.desc&limit=100', 'GET', null, { 'Accept-Profile': 'public', 'Content-Profile': 'public' });
    if (rows?.error) return NextResponse.json({ result: 'error', message: 'Could not load announcements.' });
    const visible = (rows || [])
      .filter(a => a.announcement_type === 'general' || (a.announcement_type === 'student' && student_id && a.target_student_id === student_id))
      .slice(0, 20)
      .map(({ target_student_id: _drop, ...rest }) => rest);
    return NextResponse.json({ result: 'success', announcements: visible });
  }

  // ── Get Attendance History ────────────────────────────────────────────────
  if (action === 'get_attendance') {
    const { student_id } = payload;
    const rows = await sb(`attendance_records?student_id=eq.${encodeURIComponent(student_id)}&order=date.desc&limit=60`);
    if (rows?.error) return NextResponse.json({ result: 'error', message: 'Could not load attendance.' });
    return NextResponse.json({ result: 'success', data: rows || [] });
  }

  // ── Get Attendance Summary ─────────────────────────────────────────────────
  // attendance_records has no status/method/present/absent columns (a row
  // simply IS a present day, entry/exit-time stamped by the NFC hardware) —
  // this used to filter on r.status, which never existed, so present/
  // absent/percentage were always 0. Rebuilt on the same logic
  // getMyClassAttendanceReport (ccpc-teachers/app/api/exec/route.js) already
  // uses: a date only counts as a real school day if SOMEBODY (any student)
  // has a row or override for it, not just this one child — otherwise a
  // school holiday would wrongly count as "absent". manual_attendance_
  // overrides (status: present/absent/late/leave/...) wins over a device
  // row when both exist for the same day.
  if (action === 'get_attendance_summary') {
    const { student_id } = payload;
    if (!student_id) return NextResponse.json({ result: 'error', message: 'student_id required.' });
    // allDateRows is school-wide and unfiltered by date — plain sb() would
    // silently cap at PostgREST's 3000-row max_rows with no guaranteed
    // order, corrupting total_days/percentage/by_month for every guardian
    // on a school with any real attendance history. Must paginate.
    const [ownRows, allDateRows, overrides] = await Promise.all([
      sb(`attendance_records?student_id=eq.${encodeURIComponent(student_id)}&select=date,entry_time,exit_time,pass&order=date.asc`),
      sbAllRows(`attendance_records?select=date`),
      sb(`manual_attendance_overrides?student_id=eq.${encodeURIComponent(student_id)}&select=date,status`),
    ]);
    if (ownRows?.error || allDateRows?.error || overrides?.error) {
      return NextResponse.json({ result: 'error', message: 'Could not load attendance.' });
    }
    const ownByDate = {};
    (ownRows || []).forEach(r => { ownByDate[r.date] = r; });
    const overrideByDate = {};
    (overrides || []).forEach(o => { overrideByDate[o.date] = o.status; });
    const allDates = Array.from(new Set((allDateRows || []).map(r => r.date))).sort();

    const summary = { total_days: allDates.length, present: 0, absent: 0, late: 0, leave: 0, percentage: 0, by_month: {} };
    const records = [];
    allDates.forEach(dt => {
      const own = ownByDate[dt];
      const status = overrideByDate[dt] || (own ? 'present' : 'absent');
      if (status === 'leave') summary.leave++;
      else if (status === 'late') { summary.late++; summary.present++; } // late still counts as attended
      else if (status === 'present') summary.present++;
      else summary.absent++;

      const monthKey = dt.slice(0, 7);
      if (!summary.by_month[monthKey]) summary.by_month[monthKey] = { present: 0, absent: 0, late: 0, leave: 0, total: 0 };
      summary.by_month[monthKey].total++;
      summary.by_month[monthKey][status === 'present' || status === 'late' ? 'present' : status] = (summary.by_month[monthKey][status === 'present' || status === 'late' ? 'present' : status] || 0) + 1;

      if (own || overrideByDate[dt]) {
        const history = own && own.pass && Array.isArray(own.pass.history) ? own.pass.history : [];
        records.push({
          date: dt,
          entry_time: own ? own.entry_time : null,
          exit_time: own ? own.exit_time : null,
          status,
          pass_events: history.map(h => ({ out: h.out || null, in: h.in || null, status: h.status || null })),
        });
      }
    });
    summary.percentage = summary.total_days > 0 ? Math.round((summary.present / summary.total_days) * 100) : 0;

    return NextResponse.json({ result: 'success', data: records.reverse(), summary });
  }

  // ── Manual Attendance Entry ──────────────────────────────────────────────
  // Corrections live in manual_attendance_overrides (student_id, date,
  // status, marked_by, reason) — the same table ccpc-teachers' own
  // save_manual_attendance writes to (app/api/student-admin/route.js) —
  // rather than attendance_records itself, which is device-written only
  // (entry_time/exit_time/pass come from the NFC hardware; there's no
  // status/method/recorded_by/notes column on it at all).
  if (action === 'manual_attendance_entry') {
    const { student_id, date, status, marked_by, reason } = payload;
    if (!student_id || !date || !status) {
      return NextResponse.json({ result: 'error', message: 'Student ID, date, and status are required.' });
    }
    if (new Date(date) > new Date()) {
      return NextResponse.json({ result: 'error', message: 'Cannot record attendance for future dates.' });
    }
    const record = { student_id, date, status, marked_by: marked_by || null, reason: reason || '' };
    const existing = await sb(`manual_attendance_overrides?student_id=eq.${encodeURIComponent(student_id)}&date=eq.${encodeURIComponent(date)}`);
    if (existing?.error) return NextResponse.json({ result: 'error', message: existing.error });
    if (existing.length > 0) {
      await sb(`manual_attendance_overrides?student_id=eq.${encodeURIComponent(student_id)}&date=eq.${encodeURIComponent(date)}`, 'PATCH', record);
      return NextResponse.json({ result: 'success', message: 'Attendance updated.' });
    }
    await sb('manual_attendance_overrides', 'POST', record);
    return NextResponse.json({ result: 'success', message: 'Attendance recorded.' });
  }

  // ── Bulk Attendance Import ────────────────────────────────────────────────
  if (action === 'bulk_attendance_import') {
    const { records } = payload;
    if (!Array.isArray(records) || records.length === 0) {
      return NextResponse.json({ result: 'error', message: 'No records provided.' });
    }

    const results = { inserted: 0, updated: 0, skipped: 0, errors: [] };

    for (const record of records) {
      try {
        const { student_id, date, status, marked_by, reason } = record;
        if (!student_id || !date || !status) {
          results.skipped++;
          continue;
        }
        const data = { student_id, date, status, marked_by: marked_by || null, reason: reason || '' };
        const existing = await sb(`manual_attendance_overrides?student_id=eq.${encodeURIComponent(student_id)}&date=eq.${encodeURIComponent(date)}`);
        if (existing?.error) { results.errors.push(existing.error); continue; }

        if (existing.length > 0) {
          await sb(
            `manual_attendance_overrides?student_id=eq.${encodeURIComponent(student_id)}&date=eq.${encodeURIComponent(date)}`,
            'PATCH',
            data
          );
          results.updated++;
        } else {
          await sb('manual_attendance_overrides', 'POST', data);
          results.inserted++;
        }
      } catch (e) {
        results.errors.push(e.message);
      }
    }

    return NextResponse.json({
      result: 'success',
      message: `Imported ${results.inserted} new, updated ${results.updated}`,
      details: results,
    });
  }

  // ── Export Tabs ────────────────────────────────────────────────────────────
  if (action === 'export_tabs') {
    const rows = await sb('portal_tabs?order=sort_order.asc');
    if (rows?.error) return NextResponse.json({ result: 'error', message: 'Could not load tabs.' });
    const tabs = (rows || []).map(t => ({
      tab_name: t.tab_name,
      fields_json: t.fields_json || '[]',
      condition_json: t.condition_json || '{}',
      include_fields_json: t.include_fields_json || '[]',
      icon_class: t.icon_class,
      is_enabled: t.is_enabled,
      default_editable: t.default_editable,
      sort_order: t.sort_order,
    }));
    return NextResponse.json({ result: 'success', data: tabs });
  }

  // ── Import Tabs ────────────────────────────────────────────────────────────
  if (action === 'import_tabs') {
    const { tabs_json, merge_mode } = payload;
    if (!tabs_json) return NextResponse.json({ result: 'error', message: 'No tabs data provided.' });

    let tabs = typeof tabs_json === 'string' ? JSON.parse(tabs_json) : tabs_json;
    if (!Array.isArray(tabs)) {
      return NextResponse.json({ result: 'error', message: 'Expected array of tabs.' });
    }

    const results = { created: [], updated: [], skipped: [], errors: [] };

    for (const tab of tabs) {
      try {
        if (!tab.tab_name) {
          results.skipped.push({ tab_name: '(unnamed)', reason: 'Missing tab_name' });
          continue;
        }

        const existing = await sb(`portal_tabs?tab_name=eq.${encodeURIComponent(tab.tab_name)}`);
        const isExists = existing && !existing.error && existing.length > 0;

        if (isExists && merge_mode === 'skip') {
          results.skipped.push({ tab_name: tab.tab_name, reason: 'Tab already exists' });
          continue;
        }

        const tabData = {
          tab_name: tab.tab_name,
          fields_json: tab.fields_json || '[]',
          condition_json: tab.condition_json || '{}',
          include_fields_json: tab.include_fields_json || '[]',
          icon_class: tab.icon_class || 'bi-journal-bookmark-fill',
          is_enabled: tab.is_enabled !== false,
          default_editable: tab.default_editable !== false ? 'YES' : 'NO',
          sort_order: tab.sort_order || 0,
        };

        if (isExists) {
          await sb(`portal_tabs?tab_name=eq.${encodeURIComponent(tab.tab_name)}`, 'PATCH', tabData);
          results.updated.push(tab.tab_name);
        } else {
          await sb('portal_tabs', 'POST', { ...tabData, created_at: new Date().toISOString() });
          results.created.push(tab.tab_name);
        }
      } catch (e) {
        results.errors.push({ tab_name: tab.tab_name, error: e.message });
      }
    }

    return NextResponse.json({
      result: 'success',
      message: `Imported ${results.created.length} new, updated ${results.updated.length}`,
      details: results,
    });
  }

  // ── Canteen: menu + wallet snapshot for the ordering screen ─────────────────
  if (action === 'canteen_menu') {
    const sid = payload.student_id;
    if (!sid) return NextResponse.json({ result: 'error', message: 'Student ID required.' });
    const [foods, menus, settings, srows, morders] = await Promise.all([
      sb('foods?select=*&order=name.asc'),
      sb('menus?select=*'),
      canteenSettings(),
      sb(`students_data?student_id=eq.${encodeURIComponent(sid)}&select=balance,card_status,daily_limit,monthly_limit`),
      sb(`canteen_orders?student_id=eq.${encodeURIComponent(sid)}&created_at=gte.${monthStartISO()}&select=created_at,price,orders`),
    ]);
    const allFoods = Array.isArray(foods) ? foods : [];
    const menuRows = Array.isArray(menus) ? menus : [];
    const passes = (f) => f.is_available && (f.qty ?? 0) > 0;
    let visible;
    if (!menuRows.length) visible = allFoods.filter(passes);
    else {
      const ids = resolveActiveFoodIds(menuRows);
      const byId = new Map(allFoods.map((f) => [Number(f.id), f]));
      visible = [...ids].map((id) => byId.get(Number(id))).filter((f) => f && passes(f));
    }
    const st = (Array.isArray(srows) && srows[0]) ? srows[0] : {};
    // Day-wise spend + favourites from this month's orders (same signals as the kiosk).
    const orders = Array.isArray(morders) ? morders : [];
    const todayKey = new Date().toISOString().slice(0, 10);
    let spentToday = 0, spentMonth = 0;
    const favCount = {}, favMeta = {};
    for (const o of orders) {
      const day = String(o.created_at || '').slice(0, 10);
      if (day === todayKey) spentToday += Number(o.price || 0);
      spentMonth += Number(o.price || 0);
      for (const it of (Array.isArray(o.orders) ? o.orders : [])) {
        if (it.id == null) continue;
        favCount[it.id] = (favCount[it.id] || 0) + (Number(it.qty) || 0);
        if (!favMeta[it.id]) favMeta[it.id] = { id: it.id, name: it.name };
      }
    }
    const favourites = Object.keys(favCount).sort((a, b) => favCount[b] - favCount[a]).slice(0, 4).map((id) => favMeta[id]);
    const dailyLimit = settings.enable_daily_limit ? Number(st.daily_limit || settings.general_daily_limit || 0) : 0;
    const monthlyLimit = settings.enable_monthly_limit ? Number(st.monthly_limit || settings.general_monthly_limit || 0) : 0;
    return NextResponse.json({
      result: 'success',
      foods: visible,
      wallet: {
        balance: Number(st.balance || 0),
        card_status: st.card_status || 'Active',
        daily_limit: dailyLimit, monthly_limit: monthlyLimit,
        spent_today: spentToday, spent_month: spentMonth,
        lending_limit: settings.enable_lending_limit ? Number(settings.general_lending_limit || 0) : 0,
        low_balance: Number(st.balance || 0) < Math.max(30, dailyLimit * 0.25),
        favourites,
      },
    });
  }

  // ── Profile photo — self-service upload into the public `students` Storage
  // bucket. Same trust model as every other self-service action in this
  // file (payload.student_id taken as given, e.g. canteen_menu above) — no
  // new session/auth model introduced just for this. Client sends an
  // already square-cropped, already-compressed (<=130KB, matching the
  // bucket's own limit) JPEG data URL.
  if (action === 'upload_photo') {
    const { student_id, photo_base64 } = payload;
    if (!student_id || !photo_base64) return NextResponse.json({ result: 'error', message: 'Student ID and photo required.' });
    const raw = String(photo_base64).replace(/^data:[^;]+;base64,/, '');
    const binary = atob(raw);
    const buf = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
    const contentType = (String(photo_base64).match(/data:([^;]+)/) || [])[1] || 'image/jpeg';

    const uploadRes = await fetch(`${SB_URL}/storage/v1/object/students/photo_${encodeURIComponent(student_id)}.jpg`, {
      method: 'POST',
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': contentType, 'x-upsert': 'true' },
      body: buf,
    });
    if (!uploadRes.ok) return NextResponse.json({ result: 'error', message: 'Upload failed: ' + (await uploadRes.text()).slice(0, 200) });

    const publicUrl = `${SB_URL}/storage/v1/object/public/students/photo_${encodeURIComponent(student_id)}.jpg?v=${Date.now()}`;
    const patchRes = await sb(`students_data?student_id=eq.${encodeURIComponent(student_id)}`, 'PATCH', { photo: publicUrl });
    if (patchRes?.error) return NextResponse.json({ result: 'error', message: 'Uploaded, but could not save to profile.' });
    return NextResponse.json({ result: 'success', photo: publicUrl });
  }

  // ── Canteen: place an order (prices & limits revalidated server-side) ───────
  if (action === 'canteen_place_order') {
    const { student_id, items, delivery_option } = payload;
    if (!student_id || !Array.isArray(items) || !items.length) {
      return NextResponse.json({ result: 'error', message: 'Your cart is empty.' });
    }
    const ids = [...new Set(items.map((i) => Number(i.id)).filter(Boolean))];
    if (!ids.length) return NextResponse.json({ result: 'error', message: 'Your cart is empty.' });
    const [srows, settings, foodRows] = await Promise.all([
      sb(`students_data?student_id=eq.${encodeURIComponent(student_id)}&select=*`),
      canteenSettings(),
      sb(`foods?id=in.(${ids.join(',')})&select=id,name,unit_price,is_available,qty`),
    ]);
    const student = (Array.isArray(srows) && srows[0]) ? srows[0] : null;
    if (!student) return NextResponse.json({ result: 'error', message: 'Student not found.' });
    if (student.card_status === 'Blocked' || student.card_status === 'Lost') {
      return NextResponse.json({ result: 'error', message: `Your card is ${student.card_status}. Contact the canteen office.` });
    }
    const foodById = new Map((Array.isArray(foodRows) ? foodRows : []).map((f) => [Number(f.id), f]));
    const orderItems = [];
    let total = 0;
    for (const it of items) {
      const f = foodById.get(Number(it.id));
      const qty = Math.max(0, Math.floor(Number(it.qty) || 0));
      if (!f || !f.is_available || qty <= 0) continue;
      const unit = Number(f.unit_price) || 0;
      orderItems.push({ id: f.id, name: f.name, price: unit, qty });
      total += unit * qty;
    }
    if (!orderItems.length) return NextResponse.json({ result: 'error', message: 'Those items are no longer available.' });

    const balance = Number(student.balance || 0);
    const lending = settings.enable_lending_limit ? Number(settings.general_lending_limit || 0) : 0;
    if (balance + lending < total) {
      return NextResponse.json({ result: 'error', message: `Not enough balance (limit ৳${(balance + lending).toFixed(2)}). Top up your wallet.` });
    }
    const dailyLimit = settings.enable_daily_limit ? Number(student.daily_limit || settings.general_daily_limit || 0) : 0;
    const monthlyLimit = settings.enable_monthly_limit ? Number(student.monthly_limit || settings.general_monthly_limit || 0) : 0;
    if (dailyLimit > 0 || monthlyLimit > 0) {
      const [today, month] = await Promise.all([
        dailyLimit > 0 ? sb(`canteen_orders?student_id=eq.${encodeURIComponent(student_id)}&created_at=gte.${dayStartISO()}&select=price`) : Promise.resolve([]),
        monthlyLimit > 0 ? sb(`canteen_orders?student_id=eq.${encodeURIComponent(student_id)}&created_at=gte.${monthStartISO()}&select=price`) : Promise.resolve([]),
      ]);
      const td = (Array.isArray(today) ? today : []).reduce((s, o) => s + Number(o.price || 0), 0);
      const mo = (Array.isArray(month) ? month : []).reduce((s, o) => s + Number(o.price || 0), 0);
      if (dailyLimit > 0 && td + total > dailyLimit) return NextResponse.json({ result: 'error', message: `This exceeds today's spend limit (৳${dailyLimit}).` });
      if (monthlyLimit > 0 && mo + total > monthlyLimit) return NextResponse.json({ result: 'error', message: `This exceeds the monthly spend limit (৳${monthlyLimit}).` });
    }

    const now = new Date();
    const dateStr = `${String(now.getDate()).padStart(2, '0')}${String(now.getMonth() + 1).padStart(2, '0')}${now.getFullYear()}`;
    const countRows = await sb(`canteen_orders?created_at=gte.${dayStartISO()}&select=id`);
    const seq = (Array.isArray(countRows) ? countRows.length : 0) + 1;
    const invoice = `${dateStr}-${String(seq).padStart(5, '0')}`;
    const counterNo = await canteenBestCounter();

    const newBalance = balance - total;
    const balUpd = await sb(`students_data?student_id=eq.${encodeURIComponent(student_id)}`, 'PATCH', { balance: newBalance });
    if (balUpd?.error) return NextResponse.json({ result: 'error', message: 'Could not charge your wallet. Try again.' });

    const parts = [student.class, student.section, student.group && student.group !== 'None' ? student.group : null, student.roll].filter(Boolean);
    const ins = await sb('canteen_orders', 'POST', {
      student_id, student_name: student.student_name,
      class_section_roll: parts.length ? parts.join('-') : 'N/A',
      orders: orderItems, price: total, is_delivered: false,
      delivery_option: delivery_option === 'class' ? 'class' : 'hand',
      invoice_number: invoice, counter_no: counterNo, source: 'portal',
    });
    if (ins?.error) {
      await sb(`students_data?student_id=eq.${encodeURIComponent(student_id)}`, 'PATCH', { balance }); // rollback
      return NextResponse.json({ result: 'error', message: 'Could not place the order. Your wallet was not charged.' });
    }
    await canteenNotify(student_id, `Order of ৳${total.toFixed(2)} placed from the app. Invoice ${invoice}.`, 'order');
    return NextResponse.json({ result: 'success', invoice_number: invoice, new_balance: newBalance, total });
  }

  // ── Canteen: this student's active (undelivered) orders for live tracking ───
  if (action === 'canteen_active_orders') {
    const sid = payload.student_id;
    if (!sid) return NextResponse.json({ result: 'error', message: 'Student ID required.' });
    const rows = await sb(`canteen_orders?student_id=eq.${encodeURIComponent(sid)}&is_delivered=eq.false&select=id,invoice_number,orders,price,delivery_option,counter_no,created_at,source&order=created_at.desc&limit=10`);
    return NextResponse.json({ result: 'success', orders: (Array.isArray(rows) ? rows : []) });
  }

  // ── Canteen: order + top-up history (both kiosk and portal orders) ──────────
  if (action === 'canteen_history') {
    const sid = payload.student_id;
    if (!sid) return NextResponse.json({ result: 'error', message: 'Student ID required.' });
    const [orders, topups] = await Promise.all([
      sb(`canteen_orders?student_id=eq.${encodeURIComponent(sid)}&select=id,invoice_number,orders,price,is_delivered,delivery_option,created_at,source&order=created_at.desc&limit=60`),
      sb(`recharge_history?student_id=eq.${encodeURIComponent(sid)}&select=id,amount,gateway,confirmation,created_at&order=created_at.desc&limit=60`),
    ]);
    return NextResponse.json({
      result: 'success',
      orders: (Array.isArray(orders) ? orders : []),
      topups: (Array.isArray(topups) ? topups : []),
    });
  }

  // ── Canteen: student-initiated top-up request (staff confirm in /control) ───
  if (action === 'canteen_topup_request') {
    const { student_id, amount, method, reference } = payload;
    const amt = Number(amount);
    if (!student_id || !amt || amt <= 0) return NextResponse.json({ result: 'error', message: 'Enter a valid amount.' });
    const srows = await sb(`students_data?student_id=eq.${encodeURIComponent(student_id)}&select=student_name,nfc_uid`);
    const student = (Array.isArray(srows) && srows[0]) ? srows[0] : null;
    if (!student) return NextResponse.json({ result: 'error', message: 'Student not found.' });
    const confirmationNote = reference ? `Ref: ${String(reference).slice(0, 80)}` : 'No reference given';
    const ins = await sb('recharge_history', 'POST', {
      nfc_uid: student.nfc_uid || null, student_id, student_name: student.student_name,
      amount: amt, gateway: method || 'manual', confirmation: `Pending — ${confirmationNote}`,
    });
    if (ins?.error) return NextResponse.json({ result: 'error', message: 'Could not submit your request. Try again.' });
    return NextResponse.json({ result: 'success', message: 'Top-up request submitted. It will be added once the office confirms your payment.' });
  }

  // ── Fees & Dues (read-only here — a student can view but never edit their
  // own fee/payment records; all writes happen from the admin console) ─────
  if (action === 'get_my_fees') {
    const { student_id } = payload;
    if (!student_id) return NextResponse.json({ result: 'error', message: 'student_id required.' });
    const rows = await sb(`student_fees?student_id=eq.${encodeURIComponent(student_id)}&select=*,fee_types(name,code)&order=academic_year.desc,fee_month.desc`);
    if (rows?.error) return NextResponse.json({ result: 'error', message: 'Could not load fees.' });
    return NextResponse.json({ result: 'success', fees: rows });
  }

  // ── Exam results (read-only — marks entry only happens from the admin console) ──
  if (action === 'get_my_exams') {
    const { student_id } = payload;
    const srows = await sb(`students_data?student_id=eq.${encodeURIComponent(student_id)}&select=class`);
    const cls = (!srows?.error && srows[0]) ? srows[0].class : null;
    const rows = await sb(`exams?is_locked=eq.true${cls ? `&class=eq.${encodeURIComponent(cls)}` : ''}&select=id,name,exam_type,academic_year&order=academic_year.desc`);
    if (rows?.error) return NextResponse.json({ result: 'error', message: rows.error });
    return NextResponse.json({ result: 'success', exams: rows });
  }
  if (action === 'get_my_report_card') {
    const { student_id, exam_id } = payload;
    if (!student_id || !exam_id) return NextResponse.json({ result: 'error', message: 'student_id and exam_id required.' });
    const subjects = await sb(`exam_subjects?exam_id=eq.${encodeURIComponent(exam_id)}&select=*`);
    if (subjects?.error) return NextResponse.json({ result: 'error', message: subjects.error });
    const ids = subjects.map(s => s.id).join(',') || '0';
    const marks = await sb(`exam_marks?student_id=eq.${encodeURIComponent(student_id)}&exam_subject_id=in.(${ids})&select=*`);
    const marksMap = {};
    (Array.isArray(marks) ? marks : []).forEach(m => { marksMap[m.exam_subject_id] = m.marks_obtained; });
    return NextResponse.json({ result: 'success', subjects: subjects.map(s => ({ subject: s.subject, full_marks: s.full_marks, pass_marks: s.pass_marks, marks_obtained: marksMap[s.id] ?? null })) });
  }

  return NextResponse.json({ result: 'error', message: 'Unknown action' }, { status: 400 });
}

// Returns { ok: true } or { ok: false, message } — callers must check this;
// a write can fail (constraint violation, transient error) without sb() throwing.
async function psSave(key, value) {
  const existing = await sb(`portal_settings?key=eq.${encodeURIComponent(key)}`);
  if (existing?.error) return { ok: false, message: 'Lookup failed: ' + existing.error };
  const res = existing.length
    ? await sb(`portal_settings?key=eq.${encodeURIComponent(key)}`, 'PATCH', { value, updated_at: new Date().toISOString() })
    : await sb('portal_settings', 'POST', { key, value, updated_at: new Date().toISOString() });
  if (res?.error) return { ok: false, message: 'Write failed: ' + res.error };
  return { ok: true };
}
