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

    // Try to enrich with schedule from legacy Google Sheet
    let scheduleMap = {};
    try {
      const sheetRes = await fetch(
        `https://docs.google.com/spreadsheets/d/${ROUTINE_SHEET_ID}/export?format=csv&gid=${ROUTINE_GID}`,
        { signal: AbortSignal.timeout(6000) }
      );
      if (sheetRes.ok) scheduleMap = parseSheetSchedule(await sheetRes.text());
    } catch(_) { /* schedule is optional */ }

    return NextResponse.json((rows || []).filter(t => t.full_name).map(t => ({
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
      schedule: scheduleMap[t.full_name] || [],
    })));
  }

  // ── Get Class Routine ─────────────────────────────────────────────────────
  if (action === 'get_class_routine') {
    const { class_name, section } = payload;
    const filter = section
      ? `portal_routines?class_name=eq.${encodeURIComponent(class_name)}&section=eq.${encodeURIComponent(section)}`
      : `portal_routines?class_name=eq.${encodeURIComponent(class_name)}`;
    const rows = await sb(filter);
    if (rows?.error || !rows.length) return NextResponse.json({ result: 'error', message: 'No routine found.' });
    return NextResponse.json({ result: 'success', routine: rows[0].routine || {} });
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
