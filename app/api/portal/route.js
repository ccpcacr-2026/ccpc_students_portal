import { NextResponse } from 'next/server';

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const ADMIN_ID   = process.env.ADMIN_ID   || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'adminccpcmrm';

const GP_PROD_URL  = 'https://bluebird.grameenphone.com/alo-paas';
const GP_STAGE_URL = 'https://bluebird.grameenphone.com/alo-paas-stage';

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

  // ── Save Tab Config ───────────────────────────────────────────────────────
  if (action === 'save_tab') {
    const { tab_name, fields_json, is_enabled, condition_json, icon_class, default_editable, include_fields_json } = payload;
    const existing = await sb(`portal_tabs?tab_name=eq.${encodeURIComponent(tab_name)}`);
    const rowData = { tab_name, fields_json, is_enabled, condition_json, icon_class, default_editable, include_fields_json };
    if (!existing?.error && existing.length) {
      await sb(`portal_tabs?tab_name=eq.${encodeURIComponent(tab_name)}`, 'PATCH', rowData);
    } else {
      await sb('portal_tabs', 'POST', { ...rowData, sort_order: 0 });
    }
    return NextResponse.json({ result: 'success' });
  }

  // ── Delete Tab ────────────────────────────────────────────────────────────
  if (action === 'delete_tab') {
    await sb(`portal_tabs?tab_name=eq.${encodeURIComponent(payload.tab_name)}`, 'DELETE');
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
    await psSave('bus_registry', value);
    return NextResponse.json({ result: 'success' });
  }

  // ── Save Place Registry ───────────────────────────────────────────────────
  if (action === 'save_place_registry') {
    const value = (payload.rows || []).map(r => ({ name: r[0], coords: r[1], radius: r[2] }));
    await psSave('place_registry', value);
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
    await psSave('gp_credentials', value);
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

  // ── Get Teacher Directory ─────────────────────────────────────────────────
  if (action === 'get_teacher_directory') {
    const rows = await sb('portal_teachers?order=name.asc');
    if (rows?.error) return NextResponse.json([]);
    return NextResponse.json((rows || []).map(t => ({
      name: t.name, shortName: t.short_name || t.name, photo: t.photo || '',
      mobile: t.mobile || '', email: t.email || '', schedule: t.schedule || [],
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

  return NextResponse.json({ result: 'error', message: 'Unknown action' }, { status: 400 });
}

async function psSave(key, value) {
  const existing = await sb(`portal_settings?key=eq.${encodeURIComponent(key)}`);
  if (!existing?.error && existing.length) {
    await sb(`portal_settings?key=eq.${encodeURIComponent(key)}`, 'PATCH', { value, updated_at: new Date().toISOString() });
  } else {
    await sb('portal_settings', 'POST', { key, value, updated_at: new Date().toISOString() });
  }
}
