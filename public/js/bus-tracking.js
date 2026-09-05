/**
 * Bus Tracking UI Component
 * Real-time bus positions, geofence alerts, ETA tracking via Leaflet map
 */

let map = null;
let busMarkers = {};
let allBusData = {};      // imei -> latest bus object, independent of map/selection state
let selectedImeis = new Set(); // which buses are checked "visible" in the fleet list
let geofenceCircles = {};
let busUpdateInterval = null;
let selectedBusImei = null;
let hasFittedOnce = false;
// Follow mode: tapping a bus isolates it (every other pin hidden) and
// re-centers the map on it every time a new position arrives, not just
// once at selection time — see redrawMarkers. _preFollowSelectedImeis
// remembers what was checked before so exitFollowMode can restore it
// instead of just dumping the user back to an empty map.
let _followImei = null;
let _preFollowSelectedImeis = null;

// One id per browser tab, reused across polls (so the server counts this
// tab once, not once per poll) but distinct from any other tab/device —
// backs the "N watching" live-viewer count in the toolbar.
const trackerId = sessionStorage.getItem('_bt_tid') || 'w' + Math.random().toString(36).slice(2, 10);
sessionStorage.setItem('_bt_tid', trackerId);

// Best-effort display label sent alongside every heartbeat — this app has
// no UI to show the watcher list itself (that lives in ccpc-teachers'
// admin Bus Tracker only), but still contributes a readable label into the
// shared bus_tracker_presence table so student viewers are identifiable
// there instead of showing up as blank/generic entries.
const watcherLabel = (() => {
  try {
    if (typeof loggedInStudent === 'undefined' || !loggedInStudent) return 'Guest viewer';
    if (loggedInStudent.student_id === 'admin') return 'Admin (Student Portal)';
    const name = loggedInStudent.name || loggedInStudent.student_name || loggedInStudent.student_id || 'Student';
    return `${name} (Student)`;
  } catch (e) { return 'Student'; }
})();

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
    // attributionControl:false + a hand-added one below (prefix:false) drops
    // Leaflet's own "Leaflet 🇺🇦" self-promo link — OpenStreetMap's own
    // attribution stays (required by their tile usage policy; only the
    // library's own branding is optional).
    // zoomControl:false — Leaflet auto-adds its own default zoom control
    // (topleft) unless told not to; we add our own custom-positioned one
    // below, and without this both end up on the map at once.
    map = L.map('bus-map-container', { attributionControl: false, zoomControl: false }).setView([defaultLat, defaultLng], 13);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
      maxZoom: 19,
    }).addTo(map);
    L.control.attribution({ prefix: false, position: 'bottomright' }).addTo(map);

    // bottomleft, not the default topright — on mobile the toolbar floats
    // over the top of the map (see ensureSheetHandle/CSS), which would sit
    // on top of a topright zoom control.
    L.control.zoom({ position: 'bottomleft' }).addTo(map);

    const fitBtn = document.createElement('button');
    fitBtn.className = 'bt-fit-btn';
    fitBtn.title = 'Fit all';
    fitBtn.innerHTML = '<i class="bi bi-arrows-fullscreen"></i><span class="bt-fit-label"> Fit all</span>';
    fitBtn.onclick = fitBusesInBounds;
    mapContainer.appendChild(fitBtn);

    // Mobile bottom-sheet UX: tapping the map (not a marker/control) collapses
    // the fleet sheet off-screen, giving the map the full screen.
    map.on('click', collapseFleetSheet);
  }

  ensureFleetListHead();
  ensureSheetHandle();
  loadBusTrackingConfig();
}

/**
 * Drag-handle grip pinned above the fleet list, for tapping the sheet back
 * closed below 992px (desktop/tablet hides it via CSS — the sidebar there
 * is always open, no sheet behavior at all). Inserted once from JS rather
 * than the host page's static markup so this file stays a single drop-in
 * include.
 */
function ensureSheetHandle() {
  const sidebar = document.getElementById('bus-sidebar');
  if (!sidebar || document.getElementById('bt-sheet-handle')) return;
  const handle = document.createElement('div');
  handle.id = 'bt-sheet-handle';
  handle.className = 'bt-sheet-handle';
  handle.innerHTML = `<div class="bt-sheet-grip"></div>`;
  handle.onclick = toggleFleetSheet;
  sidebar.insertBefore(handle, sidebar.firstChild);
}

/**
 * Below 992px the collapsed sheet is fully off-screen (see .bt-collapsed in
 * CSS) — #bt-fleet-toggle is the one thing that stays reachable, appearing
 * only while the sheet is closed. Desktop/tablet never shows it (CSS:
 * display:none outside the max-width:991px block) since the sidebar there
 * is never collapsed in the first place.
 */
function toggleFleetSheet() {
  const sidebar = document.getElementById('bus-sidebar');
  if (sidebar) sidebar.classList.contains('bt-collapsed') ? expandFleetSheet() : collapseFleetSheet();
}
function collapseFleetSheet() {
  const sidebar = document.getElementById('bus-sidebar');
  const toggle = document.getElementById('bt-fleet-toggle');
  if (sidebar) sidebar.classList.add('bt-collapsed');
  if (toggle) toggle.classList.add('bt-visible');
}
function expandFleetSheet() {
  const sidebar = document.getElementById('bus-sidebar');
  const toggle = document.getElementById('bt-fleet-toggle');
  if (sidebar) sidebar.classList.remove('bt-collapsed');
  if (toggle) toggle.classList.remove('bt-visible');
}

/**
 * Insert the "Fleet · All · None" header above the bus list once — done in
 * JS rather than the host page's static markup so this file stays a single
 * drop-in include (same pattern the map's own Fit-all button already uses).
 */
function ensureFleetListHead() {
  const list = document.getElementById('bus-list');
  if (!list || document.getElementById('bt-fleet-head')) return;
  const head = document.createElement('div');
  head.id = 'bt-fleet-head';
  head.className = 'bt-fleet-head';
  head.innerHTML = `
    <span class="bt-fleet-title">Fleet <span class="bt-fleet-count" id="bt-fleet-count">0</span></span>
    <div class="bt-fleet-actions">
      <button type="button" onclick="selectAllBuses()">All</button>
      <button type="button" onclick="selectNoneBuses()">None</button>
    </div>
  `;
  list.parentElement.insertBefore(head, list);
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
  // 8s was needlessly aggressive for a bus that doesn't move much in a few
  // extra seconds — 15s cuts total poll volume by ~47% with no perceptible
  // change to how "live" the map feels.
  busUpdateInterval = setInterval(updateBusPositions, 15000);
}

/**
 * Update bus positions from API
 */
async function updateBusPositions() {
  try {
    const response = await portalFetch('get_bus_data', { tracker_id: trackerId, label: watcherLabel });

    const watchingEl = document.getElementById('bt-watching-count');
    if (watchingEl && typeof response.trackers === 'number') watchingEl.textContent = response.trackers;

    if (!response.data || !Array.isArray(response.data)) {
      console.warn('Invalid bus data response');
      return;
    }

    // New buses default to visible/checked; buses no longer in the registry
    // lose their marker and drop out of the list entirely.
    const incomingImeis = new Set();
    response.data.forEach(bus => {
      incomingImeis.add(bus.imei);
      if (!allBusData[bus.imei]) selectedImeis.add(bus.imei);
      allBusData[bus.imei] = bus;
    });
    Object.keys(allBusData).forEach(imei => {
      if (!incomingImeis.has(imei)) {
        delete allBusData[imei];
        selectedImeis.delete(imei);
        removeMarker(imei);
      }
    });

    redrawMarkers();
    updateBusList(Object.values(allBusData));

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

function removeMarker(imei) {
  if (busMarkers[imei]) { map.removeLayer(busMarkers[imei]); delete busMarkers[imei]; }
}

/**
 * Create/update/remove every bus's marker to match selectedImeis — the
 * single place that reconciles "what's checked" with "what's on the map".
 */
function redrawMarkers() {
  Object.keys(allBusData).forEach(imei => {
    const bus = allBusData[imei];
    if (!selectedImeis.has(imei)) { removeMarker(imei); return; }
    if (isNaN(bus.lat) || isNaN(bus.lng)) return;

    const selected = selectedBusImei === imei;
    const icon = busMarkerIcon(bus, selected);
    const label = `<b>${busName(imei)}</b> · ${bus.isMoving ? `${bus.speed} km/h` : 'Idle'}`;

    if (busMarkers[imei]) {
      busMarkers[imei].setLatLng([bus.lat, bus.lng]);
      busMarkers[imei].setIcon(icon);
      busMarkers[imei].setTooltipContent(label);
      if (_followImei === imei) {
        map.panTo([bus.lat, bus.lng]);
        renderFollowCard(bus);
      }
    } else {
      const marker = L.marker([bus.lat, bus.lng], { icon }).addTo(map);
      marker.bindTooltip(label, { permanent: true, direction: 'top', className: 'bt-marker-label', offset: [0, selected ? -24 : -20] });
      // Leaflet markers bubble clicks to the map by default — without
      // stopping it here, this click would also fire map.on('click',
      // collapseFleetSheet) right after selectBus() expands the sheet,
      // instantly collapsing it again (looks like marker taps do nothing).
      marker.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        selectBus(imei, allBusData[imei]);
      });
      busMarkers[imei] = marker;
    }
    busMarkers[imei].busData = bus; // kept for CSV export

    checkGeofenceEvents(bus);
  });
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

  const countEl = document.getElementById('bt-fleet-count');
  if (countEl) countEl.textContent = buses.length;
  const toolbarCountEl = document.getElementById('bt-toolbar-count');
  if (toolbarCountEl) toolbarCountEl.textContent = buses.length;

  if (!buses.length) {
    listContainer.innerHTML = `<div class="bus-empty"><i class="bi bi-exclamation-circle"></i>No buses configured yet</div>`;
    return;
  }

  // Numeric-aware sort ("Bus 2" before "Bus 10") rather than API/registry order.
  const sortedBuses = [...buses].sort((a, b) =>
    busName(a.imei).localeCompare(busName(b.imei), undefined, { numeric: true, sensitivity: 'base' })
  );

  // Row 1: checkbox + name. Row 2: status badge + location. Name is
  // never truncated (see .bus-sidebar's dynamic width).
  listContainer.innerHTML = sortedBuses.map(bus => {
    const name = busName(bus.imei);
    const mv = !!bus.isMoving;
    const isSelected = selectedBusImei === bus.imei;
    const isChecked = selectedImeis.has(bus.imei);
    // Just the first segment (e.g. "Bayejid Bostami" out of "Bayejid
    // Bostami, Chattogram, Chattogram District, Chittagong...") — a full
    // address was routinely far longer than any bus name and forced the
    // panel wide just to show it; the neighborhood/area name alone is
    // what's actually useful at a glance here.
    const addr = bus.address ? bus.address.split(',')[0].trim() : 'Locating…';

    return `
      <div class="bus-list-item ${isSelected ? 'active' : ''} ${isChecked ? '' : 'dimmed'}" title="${name}" onclick='selectBus(${JSON.stringify(bus.imei)}, ${JSON.stringify(bus)})'>
        <div class="bli-row1">
          <input class="bli-check" type="checkbox" ${isChecked ? 'checked' : ''}
                 style="width:14px!important;height:14px!important;min-width:14px!important;flex-shrink:0;accent-color:#059669!important;cursor:pointer"
                 onclick="event.stopPropagation()" onchange='toggleBusVisibility(${JSON.stringify(bus.imei)}, this.checked)'>
          <span class="bli-row1-name">${name}</span>
          <span class="bli-status-dot ${mv ? 'moving' : 'idle'}"></span>
        </div>
        <div class="bli-row2">
          <span class="bli-badge-mini ${mv ? 'moving' : 'idle'}">${mv ? 'Moving' : 'Idle'}</span>
          <span class="bli-addr">${addr}</span>
        </div>
      </div>
    `;
  }).join('');
}

/**
 * Checkbox toggle for one bus's map visibility
 */
function toggleBusVisibility(imei, checked) {
  if (checked) selectedImeis.add(imei);
  else {
    selectedImeis.delete(imei);
    if (selectedBusImei === imei) exitFollowMode();
  }
  redrawMarkers();
  updateBusList(Object.values(allBusData));
}

function selectAllBuses() {
  exitFollowMode();
  Object.keys(allBusData).forEach(imei => selectedImeis.add(imei));
  redrawMarkers();
  updateBusList(Object.values(allBusData));
  fitBusesInBounds();
}

function selectNoneBuses() {
  exitFollowMode();
  selectedImeis.clear();
  redrawMarkers();
  updateBusList(Object.values(allBusData));
}

function closeBusDetails() {
  selectedBusImei = null;
  const panel = document.getElementById('bus-info-panel');
  if (panel) panel.innerHTML = `<div class="bt-info-card"><div class="bt-info-empty"><i class="bi bi-bus-front-fill"></i>Select a bus to view details</div></div>`;
}

/**
 * Turns off follow mode — restores whichever buses were checked before
 * following started (not just clearing to none, which would leave the
 * map blank) and removes the floating card.
 */
function exitFollowMode() {
  if (_followImei === null) { closeBusDetails(); return; }
  if (_preFollowSelectedImeis) selectedImeis = _preFollowSelectedImeis;
  _followImei = null;
  _preFollowSelectedImeis = null;
  closeBusDetails();
  const card = document.getElementById('bt-follow-card');
  if (card) card.remove();
  const toggle = document.getElementById('bt-fleet-toggle');
  if (toggle) toggle.style.display = '';
  redrawMarkers();
  updateBusList(Object.values(allBusData));
}

/**
 * Select a bus, isolate it on the map (every other pin hidden), and
 * follow it — the map re-centers on it every time a fresh position
 * comes in (see redrawMarkers), not just once here.
 */
function selectBus(imei, busData) {
  selectedBusImei = imei;

  if (_followImei !== imei) {
    if (_followImei === null) _preFollowSelectedImeis = new Set(selectedImeis);
    _followImei = imei;
    selectedImeis = new Set([imei]);
    redrawMarkers();
  }

  if (busMarkers[imei]) {
    busMarkers[imei].setIcon(busMarkerIcon(busData, true));
    map.panTo(busMarkers[imei].getLatLng());
  }

  updateBusInfoPanel(busData);
  renderFollowCard(busData);
  updateBusList(Object.values(allBusData));
  // Collapse the fleet sheet instead of expanding it — the whole point of
  // follow mode is a clear, unobstructed view of the map with just the
  // small floating card, not the full bottom sheet covering half the
  // screen (which is what tapping a bus used to open on mobile). The
  // "N buses" toggle pill normally shown while collapsed would otherwise
  // sit right underneath the follow card, so it's hidden too.
  collapseFleetSheet();
  const toggle = document.getElementById('bt-fleet-toggle');
  if (toggle) toggle.style.display = 'none';
}

/**
 * The follow-mode details card floated directly on the map (see
 * #bt-follow-card in public/css/bus-tracking.css for the semi-
 * transparent/blurred styling) — created once per selection, then just
 * refreshed in place on every subsequent poll tick from redrawMarkers so
 * it stays live while following, without needing to re-tap the bus.
 */
function renderFollowCard(bus) {
  const mapContainer = document.getElementById('bus-map-container');
  if (!mapContainer || _followImei !== bus.imei) return;
  let card = document.getElementById('bt-follow-card');
  if (!card) {
    card = document.createElement('div');
    card.id = 'bt-follow-card';
    mapContainer.appendChild(card);
  }
  const name = busName(bus.imei);
  const mv = !!bus.isMoving;
  const spd = Math.round(parseFloat(bus.speed)) || 0;
  card.innerHTML = `
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:6px">
      <div style="font-weight:900;font-size:11px;color:#1e293b;line-height:1.2;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${name}</div>
      <button type="button" onclick="exitFollowMode()" title="Stop following" style="width:16px;height:16px;border-radius:999px;border:none;background:rgba(15,23,42,0.1);color:#475569;font-size:10px;line-height:1;cursor:pointer;flex-shrink:0">✕</button>
    </div>
    <div style="margin-top:2px"><span style="padding:1.5px 6px;border-radius:999px;font-size:7px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;${mv ? 'background:rgba(37,99,235,0.15);color:#2563eb' : 'background:rgba(180,83,9,0.15);color:#b45309'}">${mv ? 'Moving' : 'Idle'}</span></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-top:5px">
      <div>
        <div style="font-size:7px;font-weight:800;color:#94a3b8;text-transform:uppercase">Speed</div>
        <div style="font-size:10px;font-weight:900;color:#1e293b">${spd} km/h</div>
      </div>
      <div>
        <div style="font-size:7px;font-weight:800;color:#94a3b8;text-transform:uppercase">Engine</div>
        <div style="font-size:10px;font-weight:900;color:#1e293b">${bus.engine ? 'On' : 'Off'}</div>
      </div>
    </div>
    <div style="display:flex;align-items:flex-start;gap:4px;margin-top:5px;font-size:8px;font-weight:700;color:#475569;line-height:1.3"><i class="bi bi-geo-alt-fill" style="color:#2563eb;margin-top:1px"></i><span>${bus.address || 'Locating…'}</span></div>
  `;
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
        <div class="bt-info-name">${name}</div>
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
 * Fit all currently visible (checked) buses in map bounds
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
  const headers = ['Bus Name', 'Latitude', 'Longitude', 'Speed (km/h)', 'Status', 'Address'];
  const rows = buses.map(marker => {
    const bus = marker.busData || {};
    return [
      busName(bus.imei),
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
  allBusData = {};
  selectedImeis = new Set();
  geofenceCircles = {};
  selectedBusImei = null;
  hasFittedOnce = false;
  _followImei = null;
  _preFollowSelectedImeis = null;
  const head = document.getElementById('bt-fleet-head');
  if (head) head.remove();
  const handle = document.getElementById('bt-sheet-handle');
  if (handle) handle.remove();
}

window.BusTracking = {
  initBusMap,
  stopBusTracking,
  resetBusMap,
  exportBusData,
  selectBus,
  refreshMapSize,
};
