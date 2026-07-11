import { NextResponse } from 'next/server';

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const ADMIN_ID   = process.env.ADMIN_ID   || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'adminccpcmrm';

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

function normPhone(p) { return String(p || '').replace(/\D/g, '').slice(-10); }
function normKey(s)   { return String(s || '').toLowerCase().replace(/[\s_]/g, ''); }

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

async function getGPToken(settings) {
  const apiKey  = settings.gp_api_key;
  const channel = settings.gp_channel  || 'ALOEXT';
  const baseUrl = settings.gp_env === 'staging' ? GP_STAGE_URL : GP_PROD_URL;
  if (!apiKey) throw new Error('GP API credentials not configured.');

  const r = await fetch(`${baseUrl}/auth/token`, {
    headers: { 'api-key': apiKey, channel },
  });
  const data = await r.json();
  if (data?.data?.token) return { token: data.data.token, baseUrl };
  throw new Error('GP token fetch failed: ' + JSON.stringify(data));
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

    // Collect all phone fields for verification
    const allowed = [];
    Object.entries(studentData).forEach(([k, v]) => {
      if ((k.includes('phone') || k.includes('mobile')) && v) {
        const n = normPhone(v);
        if (n && !allowed.includes(n)) allowed.push(n);
      }
    });
    const inputP = normPhone(phone_number);
    if (allowed.length > 0 && !allowed.includes(inputP)) {
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
    const r = await sb(`students_data?student_id=eq.${encodeURIComponent(student_id)}`, 'PATCH', { nfc_uid });
    if (r?.error) return NextResponse.json({ result: 'error', message: 'Update failed.' });
    return NextResponse.json({ result: 'success', message: 'NFC Tag registered successfully.' });
  }

  // ── Get Public Profile ────────────────────────────────────────────────────
  if (action === 'get_public_profile') {
    const { nfc_uid } = payload;
    const clean = String(nfc_uid || '').replace(/[\s:]/g, '').toLowerCase();
    for (const uid of [nfc_uid, clean, clean.toUpperCase()]) {
      const rows = await sb(`students_data?nfc_uid=eq.${encodeURIComponent(uid)}&select=*`);
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

    // Check if locked
    const existing = await sb(`portal_submissions?student_id=eq.${encodeURIComponent(student_id)}&tab_name=eq.${encodeURIComponent(tab_name)}`);
    if (!existing?.error && existing[0]?.editable === 'NO') {
      return NextResponse.json({ result: 'error', message: 'Permission Denied (Locked)' });
    }

    // Determine default_editable from tab config
    const tabRow = await sb(`portal_tabs?tab_name=eq.${encodeURIComponent(tab_name)}`);
    const defEdit = (tabRow && !tabRow.error && tabRow[0]) ? tabRow[0].default_editable || 'YES' : 'YES';
    const editable = (!existing?.error && existing[0]) ? existing[0].editable : defEdit;

    const cleanData = Object.fromEntries(Object.entries(data).filter(([k]) => k !== 'tabName' && k !== 'editable'));
    cleanData.updated_at = new Date().toISOString();

    if (!existing?.error && existing.length) {
      await sb(`portal_submissions?student_id=eq.${encodeURIComponent(student_id)}&tab_name=eq.${encodeURIComponent(tab_name)}`, 'PATCH',
        { data: cleanData, editable, updated_at: new Date().toISOString() });
    } else {
      await sb('portal_submissions', 'POST',
        { student_id, tab_name, data: cleanData, editable, submitted_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    }
    return NextResponse.json({ result: 'success' });
  }

  // ── Get Tab Data (Admin) ──────────────────────────────────────────────────
  if (action === 'get_tab_data') {
    const { tab_name } = payload;
    const rows = await sb(`portal_submissions?tab_name=eq.${encodeURIComponent(tab_name)}&order=submitted_at.asc`);
    if (rows?.error || !rows.length) return NextResponse.json({ headers: ['student_id'], rows: [] });
    const allKeys = new Set(['student_id']);
    rows.forEach(r => Object.keys(r.data || {}).forEach(k => allKeys.add(k)));
    const headers = [...allKeys];
    const dataRows = rows.map(r => headers.map(h => h === 'student_id' ? r.student_id : (r.data?.[h] ?? '')));
    return NextResponse.json({ headers, rows: dataRows });
  }

  // ── Get Student Data Headers ──────────────────────────────────────────────
  if (action === 'get_student_data_headers') {
    const rows = await sb('students_data?limit=1');
    if (!rows?.error && rows.length) return NextResponse.json(Object.keys(rows[0]));
    return NextResponse.json(['student_id', 'student_name', 'class', 'section', 'roll']);
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

  // ── Admin saves which profile fields students may edit ─────────────────────
  if (action === 'save_editable_fields') {
    const fields = Array.isArray(payload.fields) ? payload.fields : [];
    const r = await psSave('editable_profile_fields', JSON.stringify(fields));
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
      const { token, baseUrl } = await getGPToken(settings);
      const r = await fetch(`${baseUrl}/tracking/latest?imei=${encodeURIComponent(payload.imei)}`, {
        headers: { Authorization: `Bearer ${token}`, channel: settings.gp_channel || 'ALOEXT' },
      });
      const data = await r.json();
      if (r.ok && data?.data) {
        const d = data.data;
        return NextResponse.json({ result: 'success', data: { address: d.address || 'Unknown', speed: d.speed || 0, engine: d.ignition ? 'ON' : 'OFF', time: d.timestamp || '' } });
      }
      return NextResponse.json({ result: 'error', message: `HTTP ${r.status}: ${JSON.stringify(data)}` });
    } catch (e) {
      return NextResponse.json({ result: 'error', message: e.message });
    }
  }

  // ── Get All Bus Data (live tracker polling) ───────────────────────────────
  if (action === 'get_bus_data') {
    try {
      const rows = await sb('portal_settings?key=in.(gp_credentials,bus_registry)');
      if (rows?.error) return NextResponse.json({ result: 'error', message: 'Settings not found.' });
      const sm = {};
      rows.forEach(r => { sm[r.key] = r.value; });
      const creds = sm.gp_credentials || {};
      const busRegistry = sm.bus_registry || [];
      if (!busRegistry.length) return NextResponse.json({ result: 'success', data: [], trackers: 0, dataAge: 0 });

      const { token, baseUrl } = await getGPToken(creds);
      const imeis = busRegistry.map(b => b.imei).join(',');
      const r = await fetch(`${baseUrl}/tracking/latest?imei=${encodeURIComponent(imeis)}`, {
        headers: { Authorization: `Bearer ${token}`, channel: creds.gp_channel || 'ALOEXT' },
      });
      const json = await r.json();
      const items = Array.isArray(json?.data) ? json.data : (json?.data ? [json.data] : []);
      const dataMap = {};
      items.forEach(d => { dataMap[d.imei] = d; });

      const buses = busRegistry.map(b => {
        const d = dataMap[b.imei] || {};
        const spd = parseFloat(d.speed || 0);
        return {
          name: b.name, imei: b.imei,
          lat: parseFloat(d.latitude || d.lat || 0),
          lng: parseFloat(d.longitude || d.lng || 0),
          speed: String(spd), isMoving: spd > 2,
          engine: !!(d.ignition || d.engine),
          address: d.address || 'Unknown location',
          time: d.timestamp || d.time || '',
          heading: d.direction || 0,
        };
      });

      return NextResponse.json({ result: 'success', data: buses, trackers: 0, dataAge: 0 });
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
      { 'Accept-Profile': 'teacher', 'Content-Profile': 'teacher' }
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
  // Scans the live routine sheet directly (same "Selected" tab get_teacher_directory
  // reads) — there is no portal_routines table write path, so that table is
  // never populated; querying it always returned "No routine found."
  if (action === 'get_class_routine') {
    const { class_name, section } = payload;
    if (!class_name) return NextResponse.json({ result: 'error', message: 'class_name required.' });
    try {
      const sheetRes = await fetch(
        `https://docs.google.com/spreadsheets/d/${ROUTINE_SHEET_ID}/export?format=csv&gid=${ROUTINE_GID}`,
        { signal: AbortSignal.timeout(6000) }
      );
      if (!sheetRes.ok) return NextResponse.json({ result: 'error', message: 'Could not read the routine sheet.' });
      const rows = _parseCsv(await sheetRes.text());

      // Header row = the one containing a "1st"-style period label; the name
      // column is immediately before the first such label (same detection
      // parseSheetSchedule uses, applied here so both stay in sync).
      const hIdx = rows.findIndex(r => r.some(c => /^\d+(st|nd|rd|th)/i.test(c) || /^4th\//i.test(c)));
      if (hIdx === -1) return NextResponse.json({ result: 'error', message: 'Could not read the routine sheet header.' });
      const headers = rows[hIdx];
      const firstPeriodIdx = headers.findIndex(c => /^\d+(st|nd|rd|th)/i.test(c) || /^4th\//i.test(c));
      const nameCol = firstPeriodIdx > 0 ? firstPeriodIdx - 1 : 0;
      const dataRows = rows.slice(hIdx + 1);

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
        const rowTeacher = String(row[nameCol] || '').trim();
        if (!rowTeacher) continue;
        for (let i = firstPeriodIdx; i < headers.length; i++) {
          const cell = String(row[i] || '').trim();
          if (!cell || !cell.includes(';')) continue;
          const parts = cell.split(';');
          if (!possibleKeys.has(clean(parts[0]))) continue;

          const header = String(headers[i] || '').toLowerCase();
          let periodKey = headers[i];
          if (header.includes('junior')) periodKey = '4th/Jr';
          else if (header.includes('senior')) periodKey = '4th/Sr';
          if (!(periodKey in routine) || routine[periodKey]) continue; // first match wins

          // A trailing "(XX)" on the subject means this row's own teacher is
          // covering for XX today — the row owner is who's ACTUALLY there;
          // XX is who they're substituting for. (Verified convention — see
          // ccpc-teachers' getTodayRoutineBoard, same sheet, same annotation.)
          let subject = (parts[1] || parts[0]).trim();
          let originalShort = null;
          const adjMatch = subject.match(/\(([^)]+)\)\s*$/);
          if (adjMatch) { originalShort = adjMatch[1].trim(); subject = subject.replace(/\(([^)]+)\)\s*$/, '').trim(); }

          routine[periodKey] = {
            subject,
            teacher: shortNameMap.byShort[rowTeacher] || rowTeacher,
            originalTeacher: originalShort ? (shortNameMap.byShort[originalShort] || originalShort) : (shortNameMap.byShort[rowTeacher] || rowTeacher),
            isAdjusted: !!originalShort,
          };
        }
      }

      return NextResponse.json({ result: 'success', routine });
    } catch (e) {
      return NextResponse.json({ result: 'error', message: 'Routine lookup failed: ' + e.message });
    }
  }

  // ── Get Attendance History ────────────────────────────────────────────────
  if (action === 'get_attendance') {
    const { student_id } = payload;
    const rows = await sb(`attendance_records?student_id=eq.${encodeURIComponent(student_id)}&order=date.desc&limit=60`);
    if (rows?.error) return NextResponse.json({ result: 'error', message: 'Could not load attendance.' });
    return NextResponse.json({ result: 'success', data: rows || [] });
  }

  // ── Get Attendance Summary ─────────────────────────────────────────────────
  if (action === 'get_attendance_summary') {
    const { student_id, year, month } = payload;
    let query = `attendance_records?student_id=eq.${encodeURIComponent(student_id)}&order=date.asc`;
    const rows = await sb(query);
    if (rows?.error) return NextResponse.json({ result: 'error', message: 'Could not load attendance.' });

    // Calculate summary
    const records = rows || [];
    const summary = {
      total_days: new Set(records.map(r => r.date)).size,
      present: records.filter(r => r.status === 'present').length,
      absent: records.filter(r => r.status === 'absent').length,
      late: records.filter(r => r.status === 'late').length,
      percentage: 0,
      by_month: {},
    };

    // Calculate percentage (present + late / total)
    const attended = summary.present + summary.late;
    summary.percentage = summary.total_days > 0 ? Math.round((attended / summary.total_days) * 100) : 0;

    // Group by month
    records.forEach(r => {
      const dateObj = new Date(r.date);
      const monthKey = dateObj.toISOString().substring(0, 7); // YYYY-MM
      if (!summary.by_month[monthKey]) {
        summary.by_month[monthKey] = { present: 0, absent: 0, late: 0, total: 0 };
      }
      summary.by_month[monthKey].total++;
      summary.by_month[monthKey][r.status || 'present']++;
    });

    return NextResponse.json({ result: 'success', data: records, summary });
  }

  // ── Manual Attendance Entry ────────────────────────────────────────────────
  if (action === 'manual_attendance_entry') {
    const { student_id, date, entry_time, exit_time, status, method, recorded_by, notes } = payload;
    if (!student_id || !date) {
      return NextResponse.json({ result: 'error', message: 'Student ID and date are required.' });
    }

    // Validate date (no future dates)
    const entryDate = new Date(date);
    if (entryDate > new Date()) {
      return NextResponse.json({ result: 'error', message: 'Cannot record attendance for future dates.' });
    }

    const record = {
      student_id,
      date,
      entry_time: entry_time || null,
      exit_time: exit_time || null,
      status: status || 'present',
      method: method || 'manual',
      recorded_by: recorded_by || 'admin',
      notes: notes || null,
      recorded_at: new Date().toISOString(),
    };

    // Check for existing record
    const existing = await sb(`attendance_records?student_id=eq.${encodeURIComponent(student_id)}&date=eq.${encodeURIComponent(date)}`);

    if (existing && !existing.error && existing.length > 0) {
      // Update existing
      await sb(
        `attendance_records?student_id=eq.${encodeURIComponent(student_id)}&date=eq.${encodeURIComponent(date)}`,
        'PATCH',
        record
      );
      return NextResponse.json({ result: 'success', message: 'Attendance updated.' });
    } else {
      // Create new
      await sb('attendance_records', 'POST', record);
      return NextResponse.json({ result: 'success', message: 'Attendance recorded.' });
    }
  }

  // ── Bulk Attendance Import ─────────────────────────────────────────────────
  if (action === 'bulk_attendance_import') {
    const { records } = payload;
    if (!Array.isArray(records) || records.length === 0) {
      return NextResponse.json({ result: 'error', message: 'No records provided.' });
    }

    const results = { inserted: 0, updated: 0, skipped: 0, errors: [] };

    for (const record of records) {
      try {
        const { student_id, date, entry_time, exit_time, status, method, recorded_by, notes } = record;
        if (!student_id || !date) {
          results.skipped++;
          continue;
        }

        const data = {
          student_id,
          date,
          entry_time: entry_time || null,
          exit_time: exit_time || null,
          status: status || 'present',
          method: method || 'import',
          recorded_by: recorded_by || 'bulk_import',
          notes: notes || null,
          recorded_at: new Date().toISOString(),
        };

        const existing = await sb(`attendance_records?student_id=eq.${encodeURIComponent(student_id)}&date=eq.${encodeURIComponent(date)}`);

        if (existing && !existing.error && existing.length > 0) {
          await sb(
            `attendance_records?student_id=eq.${encodeURIComponent(student_id)}&date=eq.${encodeURIComponent(date)}`,
            'PATCH',
            data
          );
          results.updated++;
        } else {
          await sb('attendance_records', 'POST', data);
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

    const parts = [student.class, student.section, student.roll].filter(Boolean);
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
