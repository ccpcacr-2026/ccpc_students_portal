/**
 * Bus Tracking UI Component
 * Real-time bus positions, geofence alerts, ETA tracking via Leaflet map
 */

let map = null;
let busMarkers = {};
let geofenceCircles = {};
let busUpdateInterval = null;
let selectedBusImei = null;
let hasFittedOnce = false;

/**
 * Initialize Leaflet map
 */
function initBusMap() {
  const mapContainer = document.getElementById('bus-map-container');
  if (!mapContainer) return;

  // Default center (Dhaka, Bangladesh)
  const defaultLat = 23.8103;
  const defaultLng = 90.4125;

  if (!map) {
    map = L.map('bus-map-container').setView([defaultLat, defaultLng], 13);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);

    L.control.zoom({ position: 'topright' }).addTo(map);

    const fitBtn = document.createElement('button');
    fitBtn.className = 'bt-fit-btn';
    fitBtn.innerHTML = '<i class="bi bi-arrows-fullscreen"></i> Fit all';
    fitBtn.onclick = fitBusesInBounds;
    mapContainer.appendChild(fitBtn);
  }

  loadBusTrackingConfig();
}

/**
 * Load bus registry and place registry from portal settings
 */
async function loadBusTrackingConfig() {
  try {
    const response = await portalFetch('get_tracking_config', {});

    if (response.busRegistry) {
      window.busRegistry = response.busRegistry;
    }

    if (response.placeRegistry) {
      response.placeRegistry.forEach(place => {
        const [name, coordsStr, radius] = place;
        try {
          const [lat, lng] = coordsStr.split(',').map(s => parseFloat(s.trim()));
          if (!isNaN(lat) && !isNaN(lng)) {
            addGeofenceCircle(name, lat, lng, parseInt(radius) || 100);
          }
        } catch (e) {
          console.warn('Failed to parse geofence coords:', coordsStr);
        }
      });
    }

    startBusTracking();
  } catch (err) {
    console.error('Failed to load tracking config:', err);
  }
}

/**
 * Add geofence circle to map
 */
function addGeofenceCircle(name, lat, lng, radius) {
  if (geofenceCircles[name]) {
    map.removeLayer(geofenceCircles[name]);
  }

  const circle = L.circle([lat, lng], {
    color: '#059669',
    fillColor: '#10b981',
    fillOpacity: 0.1,
    weight: 2,
    radius: radius, // meters
  }).addTo(map);

  circle.bindPopup(`<strong>${name}</strong><br/>Radius: ${radius}m`);
  geofenceCircles[name] = circle;
}

/**
 * Start polling for bus positions
 */
function startBusTracking() {
  updateBusPositions();
  if (busUpdateInterval) clearInterval(busUpdateInterval);
  busUpdateInterval = setInterval(updateBusPositions, 30000);
}

/**
 * Update bus positions from API
 */
async function updateBusPositions() {
  try {
    const response = await portalFetch('get_bus_data', {});

    if (!response.data || !Array.isArray(response.data)) {
      console.warn('Invalid bus data response');
      return;
    }

    response.data.forEach(bus => updateBusMarker(bus));
    updateBusList(response.data);

    // Fit the map to wherever the buses actually are on the very first
    // successful load — the map's default view is a generic city center,
    // not the school's actual location, so real bus positions can easily
    // fall outside it (list populates fine either way; only the map looks
    // empty). After this first fit the user's own pan/zoom is left alone.
    if (!hasFittedOnce && Object.keys(busMarkers).length) {
      hasFittedOnce = true;
      fitBusesInBounds();
    }

    const timeEl = document.getElementById('bus-data-timestamp');
    if (timeEl) timeEl.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch (err) {
    console.error('Failed to update bus positions:', err);
  }
}

/**
 * Build the pulsing gradient marker icon used both on the map and (larger) when selected
 */
function busMarkerIcon(bus, selected) {
  const mv = !!bus.isMoving;
  const color = mv ? '#059669' : '#F59E0B';
  const dark = mv ? '#047857' : '#B45309';
  const size = selected ? 42 : 34;
  const pulse = mv ? `<div class="bt-marker-pulse" style="border-color:${color}"></div>` : '';

  return L.divIcon({
    className: '',
    html: `<div class="bt-marker-wrap">
      ${pulse}
      <div class="bt-marker-circle" style="width:${size}px;height:${size}px;background:linear-gradient(135deg,${color},${dark})">
        <i class="bi bi-bus-front-fill"></i>
      </div>
    </div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function busName(imei) {
  if (window.busRegistry && Array.isArray(window.busRegistry)) {
    const found = window.busRegistry.find(b => b[1] === imei);
    if (found) return found[0];
  }
  return imei;
}

/**
 * Update or create bus marker on map
 */
function updateBusMarker(bus) {
  const { imei, lat, lng } = bus;
  if (!imei || isNaN(lat) || isNaN(lng)) return;

  const selected = selectedBusImei === imei;
  const icon = busMarkerIcon(bus, selected);
  const label = `<b>${busName(imei)}</b> · ${bus.isMoving ? `${bus.speed} km/h` : 'Idle'}`;

  if (busMarkers[imei]) {
    busMarkers[imei].setLatLng([lat, lng]);
    busMarkers[imei].setIcon(icon);
    busMarkers[imei].setTooltipContent(label);
  } else {
    const marker = L.marker([lat, lng], { icon }).addTo(map);
    marker.bindTooltip(label, { permanent: true, direction: 'top', className: 'bt-marker-label', offset: [0, selected ? -24 : -20] });
    marker.on('click', () => selectBus(imei, bus));
    busMarkers[imei] = marker;
  }
  busMarkers[imei].busData = bus; // kept for CSV export

  checkGeofenceEvents(bus);
}

/**
 * Check if bus entered/exited geofences
 */
function checkGeofenceEvents(bus) {
  const { imei, lat, lng } = bus;
  if (!window.busRegistry || !Array.isArray(window.busRegistry)) return;

  const name = busName(imei);

  Object.entries(geofenceCircles).forEach(([geoName, geoCircle]) => {
    const geoLatLng = geoCircle.getLatLng();
    const distance = geoLatLng.distanceTo(L.latLng(lat, lng));
    const radius = geoCircle.getRadius();

    const wasInside = geoCircle._busWasInside || false;
    const isInside = distance <= radius;

    if (isInside && !wasInside) showGeofenceAlert(`${name} entered ${geoName}`, 'success', 'bi-geo-alt-fill');
    if (!isInside && wasInside) showGeofenceAlert(`${name} exited ${geoName}`, 'warning', 'bi-arrow-right-circle-fill');

    geoCircle._busWasInside = isInside;
  });
}

/**
 * Show geofence alert toast
 */
function showGeofenceAlert(message, type = 'info', icon = 'bi-info-circle-fill') {
  const alertsContainer = document.getElementById('geofence-alerts');
  if (!alertsContainer) return;

  const alert = document.createElement('div');
  alert.className = `alert alert-${type} alert-dismissible fade show`;
  alert.role = 'alert';
  alert.innerHTML = `<i class="bi ${icon}"></i> ${message}
    <button type="button" class="btn-close" data-bs-dismiss="alert" style="font-size:0.6rem"></button>`;

  alertsContainer.insertBefore(alert, alertsContainer.firstChild);

  setTimeout(() => { if (alert.parentElement) alert.remove(); }, 5000);
}

/**
 * Update bus list in sidebar
 */
function updateBusList(buses) {
  const listContainer = document.getElementById('bus-list');
  if (!listContainer) return;

  if (!buses.length) {
    listContainer.innerHTML = `<div class="bus-empty"><i class="bi bi-exclamation-circle"></i>No buses configured yet</div>`;
    return;
  }

  listContainer.innerHTML = buses.map(bus => {
    const name = busName(bus.imei);
    const mv = !!bus.isMoving;
    const isSelected = selectedBusImei === bus.imei;
    const spd = parseFloat(bus.speed) || 0;
    const addr = (bus.address || 'Locating…');

    return `
      <div class="bus-list-item ${isSelected ? 'active' : ''}" title="${bus.imei}" onclick='selectBus(${JSON.stringify(bus.imei)}, ${JSON.stringify(bus)})'>
        <div class="bli-top">
          <div class="bli-avatar ${mv ? 'moving' : 'idle'}"><i class="bi bi-bus-front-fill"></i></div>
          <div class="bli-info">
            <div class="bli-name">${name}</div>
          </div>
          <div class="bli-dot ${mv ? 'moving' : 'idle'}"></div>
        </div>
        <div class="bli-meta"><span class="spd ${mv ? 'moving' : 'idle'}">${mv ? `${spd} km/h` : 'Idle'}</span><span class="sep">·</span>${addr}</div>
      </div>
    `;
  }).join('');
}

/**
 * Select a bus and highlight on map
 */
function selectBus(imei, busData) {
  selectedBusImei = imei;

  if (busMarkers[imei]) {
    busMarkers[imei].setIcon(busMarkerIcon(busData, true));
    map.panTo(busMarkers[imei].getLatLng());
  }

  updateBusInfoPanel(busData);
  updateBusList(Object.values(busMarkers).map(m => m.busData).filter(Boolean));
}

/**
 * Update bus info panel with details
 */
function updateBusInfoPanel(bus) {
  const panel = document.getElementById('bus-info-panel');
  if (!panel) return;

  const name = busName(bus.imei);
  const mv = !!bus.isMoving;
  const spd = parseFloat(bus.speed) || 0;
  const etaHtml = calculateETA(bus);

  panel.innerHTML = `
    <div class="bt-info-card">
      <div class="bt-info-head">
        <div>
          <div class="bt-info-name">${name}</div>
          <div class="bt-info-imei">${bus.imei}</div>
        </div>
        <div class="bt-badge ${mv ? 'moving' : 'idle'}">● ${mv ? 'Moving' : 'Idle'}</div>
      </div>
      <div class="bt-info-body">
        <div class="bt-stat-row">
          <div class="bt-stat">
            <div class="bt-stat-label">Speed</div>
            <div class="bt-stat-val">${spd} km/h</div>
          </div>
          <div class="bt-stat">
            <div class="bt-stat-label">Engine</div>
            <div class="bt-stat-val">${bus.engine ? 'On' : 'Off'}</div>
          </div>
        </div>
        <div class="bt-info-addr"><i class="bi bi-geo-alt-fill"></i>${bus.address || 'Locating…'}</div>
        ${etaHtml}
      </div>
    </div>
  `;
}

/**
 * Calculate ETA to nearest geofence
 */
function calculateETA(bus) {
  if (!bus.isMoving) return '';

  let nearest = null;
  let minDistance = Infinity;

  Object.entries(geofenceCircles).forEach(([name, circle]) => {
    const latLng = circle.getLatLng();
    const distance = latLng.distanceTo(L.latLng(bus.lat, bus.lng));
    if (distance < minDistance) {
      minDistance = distance;
      nearest = { name, distance };
    }
  });

  if (!nearest || nearest.distance <= 100) return '';

  const speedMs = bus.speed / 3.6;
  const etaMinutes = Math.round((nearest.distance / speedMs) / 60);

  return `<div class="bt-eta"><span><i class="bi bi-signpost-fill"></i> ETA to ${nearest.name}</span><span>${etaMinutes} min · ${(nearest.distance / 1000).toFixed(1)} km</span></div>`;
}

/**
 * Fit all buses in map bounds
 */
function fitBusesInBounds() {
  if (Object.keys(busMarkers).length === 0) return;
  const group = new L.featureGroup(Object.values(busMarkers));
  map.fitBounds(group.getBounds().pad(0.1));
}

/**
 * Stop tracking
 */
function stopBusTracking() {
  if (busUpdateInterval) {
    clearInterval(busUpdateInterval);
    busUpdateInterval = null;
  }
}

/**
 * Export bus data as CSV
 */
function exportBusData() {
  if (!Object.keys(busMarkers).length) {
    alert('No bus data to export');
    return;
  }

  const buses = Object.values(busMarkers);
  const headers = ['Bus Name', 'IMEI', 'Latitude', 'Longitude', 'Speed (km/h)', 'Status', 'Address'];
  const rows = buses.map(marker => {
    const bus = marker.busData || {};
    return [
      busName(bus.imei),
      bus.imei,
      bus.lat,
      bus.lng,
      bus.speed,
      bus.isMoving ? 'Moving' : 'Stationary',
      bus.address,
    ];
  });

  const csv = [headers, ...rows]
    .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\n');

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `bus-tracking-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Recalculate the map's size after its container becomes visible.
 * The map is initialized inside a hidden tab-pane (display:none), so Leaflet
 * sizes it 0x0; without this call the map stays gray when the tab opens.
 */
function refreshMapSize() {
  if (map) setTimeout(() => map.invalidateSize(), 50);
}

/**
 * Full teardown — used when the map's container div is about to be removed
 * from the DOM (e.g. navigating to a different view in a single-page host),
 * so a later initBusMap() call creates a fresh Leaflet instance instead of
 * silently no-op'ing on the (now-detached) old one.
 */
function resetBusMap() {
  stopBusTracking();
  if (map) { try { map.remove(); } catch (_) {} }
  map = null;
  busMarkers = {};
  geofenceCircles = {};
  selectedBusImei = null;
  hasFittedOnce = false;
}

window.BusTracking = {
  initBusMap,
  stopBusTracking,
  resetBusMap,
  exportBusData,
  selectBus,
  refreshMapSize,
};
