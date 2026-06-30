/**
 * Grameenphone ALO PAAS Bus Tracking Integration
 * Handles GP API authentication, caching, and bus data fetching
 */

const GP_PROD_URL = 'https://bluebird.grameenphone.com/alo-paas';
const GP_STAGE_URL = 'https://bluebird.grameenphone.com/alo-paas-stage';
const TOKEN_CACHE_DURATION = 30 * 60 * 1000; // 30 minutes
const DATA_CACHE_DURATION = 30 * 1000; // 30 seconds

// In-memory caches (volatile, reset on server restart)
let tokenCache = { token: null, expiry: 0 };
let dataCache = { data: null, expiry: 0 };

/**
 * Get or refresh GP API token
 * Caches token for 30 minutes
 */
export async function getGPToken(credentials) {
  const now = Date.now();

  // Return cached token if still valid
  if (tokenCache.token && now < tokenCache.expiry - 5 * 60 * 1000) {
    return tokenCache.token;
  }

  // Fetch new token
  try {
    const { username, password, channel = 'ALOEXT', environment = 'production' } = credentials;

    if (!username || !password) {
      throw new Error('GP credentials (username/password) not configured');
    }

    const baseUrl = environment === 'staging' ? GP_STAGE_URL : GP_PROD_URL;
    const authHeader = Buffer.from(`${username}:${password}`).toString('base64');

    const response = await fetch(`${baseUrl}/auth/token`, {
      method: 'GET',
      headers: {
        'api-key': authHeader,
        'channel': channel,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      const detail = tryParseJSON(text)?.message || text;
      throw new Error(`GP token error (HTTP ${response.status}): ${detail}`);
    }

    const data = await response.json();
    const token = data?.data?.token;
    const expiry = data?.data?.expireTime;

    if (!token) {
      throw new Error('No token in GP response');
    }

    // Cache the token
    tokenCache = {
      token,
      expiry: expiry ? new Date(expiry).getTime() : now + TOKEN_CACHE_DURATION,
    };

    return token;
  } catch (err) {
    console.error('getGPToken failed:', err.message);
    throw err;
  }
}

/**
 * Test GP API connection
 */
export async function testGPConnection(credentials) {
  try {
    await getGPToken(credentials);
    return { result: 'success', message: 'GP connection successful!' };
  } catch (err) {
    return { result: 'error', message: err.message };
  }
}

/**
 * Fetch latest GPS data for buses
 * Uses 30-second cache to reduce API calls
 * Returns array: [{ imei, latitude, longitude, speed, isMoving, address, timestamp }, ...]
 */
export async function getLatestBusData(imeis, credentials, skipCache = false) {
  const now = Date.now();

  // Return cached data if available (unless skipCache=true)
  if (!skipCache && dataCache.data && now < dataCache.expiry) {
    return dataCache.data;
  }

  try {
    const token = await getGPToken(credentials);
    const { environment = 'production' } = credentials;
    const baseUrl = environment === 'staging' ? GP_STAGE_URL : GP_PROD_URL;

    // Format IMEI list for API
    const imeiParam = Array.isArray(imeis) ? imeis.join(',') : imeis;

    const response = await fetch(`${baseUrl}/api/querydevicelist`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        imeis: imeiParam,
        needLocation: true,
      }),
    });

    if (!response.ok) {
      throw new Error(`GP API error (HTTP ${response.status})`);
    }

    const result = await response.json();

    // Parse GP response format
    // Expected: { data: { devices: [ { imei, lat, lng, speed, ... } ] } }
    const devices = result?.data?.devices || [];
    const busData = devices.map(device => ({
      imei: device.imei,
      latitude: parseFloat(device.lat || device.latitude),
      longitude: parseFloat(device.lng || device.longitude),
      speed: parseFloat(device.speed || 0),
      isMoving: parseFloat(device.speed || 0) > 2, // >2 km/h = moving
      engine: device.engine || 'unknown',
      address: device.address || 'Locating...',
      timestamp: device.timestamp || new Date().toISOString(),
    }));

    // Cache the data
    dataCache = {
      data: busData,
      expiry: now + DATA_CACHE_DURATION,
    };

    return busData;
  } catch (err) {
    console.error('getLatestBusData failed:', err.message);
    // Return empty array on error (don't crash)
    return [];
  }
}

/**
 * Fetch movement history for a specific IMEI
 * Returns array of timestamped positions
 */
export async function getBusMovementLog(imei, startTime, endTime, credentials) {
  try {
    const token = await getGPToken(credentials);
    const { environment = 'production' } = credentials;
    const baseUrl = environment === 'staging' ? GP_STAGE_URL : GP_PROD_URL;

    const response = await fetch(`${baseUrl}/api/querytrackdata`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        imei: imei,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        pageSize: 1000,
      }),
    });

    if (!response.ok) {
      throw new Error(`GP API error (HTTP ${response.status})`);
    }

    const result = await response.json();
    const tracks = result?.data?.tracks || [];

    return tracks.map(track => ({
      latitude: parseFloat(track.lat),
      longitude: parseFloat(track.lng),
      speed: parseFloat(track.speed || 0),
      bearing: parseFloat(track.bearing || 0),
      timestamp: track.time,
      address: track.address || '',
    }));
  } catch (err) {
    console.error('getBusMovementLog failed:', err.message);
    return [];
  }
}

/**
 * Calculate distance between two coordinates (Haversine formula)
 * Returns distance in meters
 */
export function calculateDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000; // Earth radius in meters
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

/**
 * Check if position is within a geofence
 */
export function isWithinGeofence(lat, lng, geofence) {
  if (!geofence || !geofence.latitude || !geofence.longitude || !geofence.radius) {
    return false;
  }
  const distance = calculateDistance(lat, lng, geofence.latitude, geofence.longitude);
  return distance <= geofence.radius;
}

/**
 * Detect geofence events based on movement
 * Returns: { entered: [...], exited: [...] }
 */
export function detectGeofenceEvents(currentPos, previousPos, geofences) {
  const events = { entered: [], exited: [] };

  if (!Array.isArray(geofences)) return events;

  for (const geofence of geofences) {
    const now = isWithinGeofence(currentPos.latitude, currentPos.longitude, geofence);
    const before = previousPos
      ? isWithinGeofence(previousPos.latitude, previousPos.longitude, geofence)
      : false;

    if (now && !before) {
      events.entered.push(geofence);
    } else if (!now && before) {
      events.exited.push(geofence);
    }
  }

  return events;
}

/**
 * Estimate ETA to geofence (simple linear extrapolation)
 */
export function estimateETA(currentPos, geofence) {
  if (!currentPos || !geofence || currentPos.speed < 1) {
    return null; // Bus not moving
  }

  const distance = calculateDistance(
    currentPos.latitude,
    currentPos.longitude,
    geofence.latitude,
    geofence.longitude
  );

  if (distance <= geofence.radius) {
    return { status: 'arrived', eta: new Date() };
  }

  // speed is in km/h, convert to m/s
  const speedMs = (currentPos.speed / 3.6);
  const etaSeconds = distance / speedMs;
  const eta = new Date(Date.now() + etaSeconds * 1000);

  return {
    status: 'en-route',
    distance: Math.round(distance),
    eta,
  };
}

/**
 * Helper: try to parse JSON safely
 */
function tryParseJSON(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

/**
 * Clear caches (useful for testing or manual refresh)
 */
export function clearCaches() {
  tokenCache = { token: null, expiry: 0 };
  dataCache = { data: null, expiry: 0 };
}

export default {
  getGPToken,
  testGPConnection,
  getLatestBusData,
  getBusMovementLog,
  calculateDistance,
  isWithinGeofence,
  detectGeofenceEvents,
  estimateETA,
  clearCaches,
};
