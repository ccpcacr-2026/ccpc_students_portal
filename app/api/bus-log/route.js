import { NextResponse } from 'next/server';

// Background bus-location logger, pinged by pg_cron every 30 seconds.
// Runs here (not in Postgres) because GP's API accepts connections from
// Vercel but resets TLS from the Supabase DB host. Reuses the GP token via
// the portal_settings gp_poller_token row and inserts a history row only
// when a bus has moved >20 m since its last saved fix.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const GP_PROD_URL  = 'https://bluebird.grameenphone.com/alo-paas';
const GP_STAGE_URL = 'https://bluebird.grameenphone.com/alo-paas-stage';

async function sb(path, method = 'GET', body = null) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      'Accept-Profile': 'student',
      'Content-Profile': 'student',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  try {
    const json = JSON.parse(text);
    if (r.status >= 400) return { error: text };
    return json;
  } catch {
    return r.status >= 400 ? { error: text } : [];
  }
}

async function getToken(creds, baseUrl) {
  // reuse a cached token for 30 minutes — GP throttles rapid token requests
  const rows = await sb('portal_settings?key=eq.gp_poller_token');
  const cached = (!rows?.error && rows[0]) ? rows[0].value : null;
  if (cached?.token && cached.ts && (Date.now() - new Date(cached.ts).getTime()) < 30 * 60 * 1000) {
    return cached.token;
  }
  const r = await fetch(`${baseUrl}/auth/token`, {
    headers: { 'api-key': creds.api_key, channel: creds.channel || 'ALOEXT' },
  });
  const data = await r.json();
  const token = data?.data?.token;
  if (!token) throw new Error('GP token fetch failed');
  const value = { token, ts: new Date().toISOString() };
  const upd = await sb('portal_settings?key=eq.gp_poller_token', 'PATCH', { value });
  if (upd?.error || (Array.isArray(upd) && upd.length === 0)) {
    await sb('portal_settings', 'POST', { key: 'gp_poller_token', value });
  }
  return token;
}

export async function GET(req) {
  // shared-secret gate (set BUS_LOG_KEY in Vercel env and in the pg_cron ping URL)
  const expected = process.env.BUS_LOG_KEY;
  if (expected) {
    const got = new URL(req.url).searchParams.get('key');
    if (got !== expected) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  try {
    const rows = await sb('portal_settings?key=in.(gp_credentials,bus_registry)');
    if (rows?.error) return NextResponse.json({ error: 'settings unavailable' }, { status: 500 });
    const sm = {};
    rows.forEach(r => { sm[r.key] = r.value; });
    const creds = sm.gp_credentials;
    const registry = Array.isArray(sm.bus_registry) ? sm.bus_registry : [];
    if (!creds?.api_key || registry.length === 0) {
      return NextResponse.json({ ok: true, logged: 0, note: 'no credentials or buses configured' });
    }

    const baseUrl = creds.environment === 'staging' ? GP_STAGE_URL : GP_PROD_URL;
    let token = await getToken(creds, baseUrl);

    let r = await fetch(`${baseUrl}/api/v1/vts/location/current-attributes`, {
      method: 'POST',
      headers: {
        'api-key': creds.api_key,
        channel: creds.channel || 'ALOEXT',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ imei: registry.map(b => String(b.imei)) }),
    });
    if (r.status === 401 || r.status === 403) {
      // stale cached token: drop it and retry once with a fresh one
      await sb('portal_settings?key=eq.gp_poller_token', 'DELETE');
      token = await getToken(creds, baseUrl);
      r = await fetch(`${baseUrl}/api/v1/vts/location/current-attributes`, {
        method: 'POST',
        headers: {
          'api-key': creds.api_key,
          channel: creds.channel || 'ALOEXT',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ imei: registry.map(b => String(b.imei)) }),
      });
    }
    const json = await r.json();
    if (!r.ok) return NextResponse.json({ error: `GP ${r.status}` }, { status: 502 });
    const items = Array.isArray(json?.data) ? json.data : [];

    let logged = 0;
    for (const d of items) {
      const lat = parseFloat(d.latitude || 0);
      const lng = parseFloat(d.longitude || 0);
      if (!lat && !lng) continue;

      const lastRows = await sb(`bus_location_history?imei=eq.${encodeURIComponent(d.imei)}&order=recorded_at.desc&limit=1&select=lat,lng`);
      const last = (!lastRows?.error && lastRows[0]) ? lastRows[0] : null;
      if (last) {
        // equirectangular approximation in meters; 20 m gate filters GPS jitter while parked
        const distM = 111320 * Math.sqrt(
          Math.pow(lat - last.lat, 2) +
          Math.pow((lng - last.lng) * Math.cos(lat * Math.PI / 180), 2)
        );
        if (distM <= 20) continue;
      }

      const bus = registry.find(b => String(b.imei) === String(d.imei));
      const ins = await sb('bus_location_history', 'POST', {
        imei: String(d.imei),
        name: bus?.name || null,
        lat, lng,
        speed: String(d.speed ?? '0'),
        engine: !!d.engineStatus,
        heading: parseFloat(d.heading || 0),
        address: d.address || '',
        location_time: d.locationTime || '',
      });
      if (!ins?.error) logged++;
    }

    return NextResponse.json({ ok: true, buses: items.length, logged });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
