/**
 * Bus Tracking UI Component
 * Real-time bus positions, geofence alerts, ETA tracking via Leaflet map
 */

let map = null;
let busMarkers = {};
let geofenceCircles = {};
let busUpdateInterval = null;
let selectedBusImei = null;

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

    // Add zoom controls
    L.control.zoom({ position: 'topright' }).addTo(map);

    // Fit bounds button
    const fitBtn = document.createElement('button');
    fitBtn.className = 'btn btn-sm btn-outline-primary';
    fitBtn.innerHTML = '<i class="bi bi-arrows-fullscreen"></i> Fit All Buses';
    fitBtn.style.position = 'absolute';
    fitBtn.style.bottom = '20px';
    fitBtn.style.right = '10px';
    fitBtn.style.zIndex = '1000';
    fitBtn.onclick = fitBusesInBounds;
    mapContainer.appendChild(fitBtn);
  }

  // Load bus tracking config and start polling
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
      // Parse place registry and add geofence circles
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

    // Start polling bus data
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
    popup: `<strong>${name}</strong><br/>Radius: ${radius}m`,
  }).addTo(map);

  circle.bindPopup(`<strong>${name}</strong><br/>Radius: ${radius}m`);
  geofenceCircles[name] = circle;
}

/**
 * Start polling for bus positions
 */
function startBusTracking() {
  // Initial fetch
  updateBusPositions();

  // Poll every 30 seconds
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

    // Update each bus
    response.data.forEach(bus => {
      updateBusMarker(bus);
    });

    // Update bus list
    updateBusList(response.data);

    // Update timestamp
    const timeEl = document.getElementById('bus-data-timestamp');
    if (timeEl) {
      timeEl.textContent = new Date().toLocaleTimeString();
    }
  } catch (err) {
    console.error('Failed to update bus positions:', err);
  }
}

/**
 * Update or create bus marker on map
 */
function updateBusMarker(bus) {
  const { imei, latitude, longitude, speed, isMoving, address } = bus;

  if (!imei || isNaN(latitude) || isNaN(longitude)) return;

  // Remove old marker
  if (busMarkers[imei]) {
    map.removeLayer(busMarkers[imei]);
  }

  // Create marker icon based on movement
  const iconColor = isMoving ? '#ef4444' : '#059669'; // Red = moving, Green = stationary
  const iconSize = selectedBusImei === imei ? 40 : 30;

  const busIcon = L.divIcon({
    html: `
      <div style="
        width: ${iconSize}px;
        height: ${iconSize}px;
        background: ${iconColor};
        border: 3px solid white;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      ">
        <i style="color: white; font-size: 14px;" class="bi bi-bus-front-fill"></i>
      </div>
    `,
    iconSize: [iconSize, iconSize],
    className: 'bus-marker',
  });

  const marker = L.marker([latitude, longitude], { icon: busIcon, rotationAngle: 0 });
  marker.bindPopup(`
    <strong>Bus: ${imei}</strong><br/>
    Speed: ${speed} km/h<br/>
    Status: ${isMoving ? '🔴 Moving' : '🟢 Stationary'}<br/>
    Address: ${address || 'Locating...'}
  `);

  marker.on('click', () => selectBus(imei, bus));
  marker.addTo(map);
  busMarkers[imei] = marker;

  // Check geofence events
  checkGeofenceEvents(bus);
}

/**
 * Check if bus entered/exited geofences
 */
function checkGeofenceEvents(bus) {
  const { imei, latitude, longitude } = bus;

  if (!window.busRegistry || !Array.isArray(window.busRegistry)) return;

  // Get bus name from registry
  const busName = window.busRegistry.find(b => b[1] === imei)?.[0] || imei;

  // Check each geofence
  Object.entries(geofenceCircles).forEach(([geoName, geoCircle]) => {
    const geoLatLng = geoCircle.getLatLng();
    const distance = geoLatLng.distanceTo(L.latLng(latitude, longitude));
    const radius = geoCircle.getRadius();

    const wasInside = geoCircle._busWasInside || false;
    const isInside = distance <= radius;

    // Detect entry
    if (isInside && !wasInside) {
      showGeofenceAlert(`${busName} entered ${geoName}`, 'success');
    }

    // Detect exit
    if (!isInside && wasInside) {
      showGeofenceAlert(`${busName} exited ${geoName}`, 'warning');
    }

    geoCircle._busWasInside = isInside;
  });
}

/**
 * Show geofence alert toast
 */
function showGeofenceAlert(message, type = 'info') {
  const alertsContainer = document.getElementById('geofence-alerts');
  if (!alertsContainer) return;

  const alert = document.createElement('div');
  alert.className = `alert alert-${type} alert-dismissible fade show`;
  alert.role = 'alert';
  alert.innerHTML = `
    ${message}
    <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
  `;

  alertsContainer.insertBefore(alert, alertsContainer.firstChild);

  // Auto-dismiss after 5 seconds
  setTimeout(() => {
    if (alert.parentElement) {
      alert.remove();
    }
  }, 5000);
}

/**
 * Update bus list in sidebar
 */
function updateBusList(buses) {
  const listContainer = document.getElementById('bus-list');
  if (!listContainer) return;

  const busMap = new Map();
  if (window.busRegistry && Array.isArray(window.busRegistry)) {
    window.busRegistry.forEach(b => busMap.set(b[1], b[0]));
  }

  listContainer.innerHTML = buses.map(bus => {
    const busName = busMap.get(bus.imei) || bus.imei;
    const statusIcon = bus.isMoving ? '🔴' : '🟢';
    const isSelected = selectedBusImei === bus.imei;

    return `
      <div class="bus-list-item ${isSelected ? 'active' : ''}" onclick="selectBus('${bus.imei}', ${JSON.stringify(bus)})">
        <div class="d-flex justify-content-between align-items-start">
          <div>
            <div class="fw-600">${busName}</div>
            <small class="text-muted">${bus.imei}</small>
          </div>
          <span style="font-size: 18px;">${statusIcon}</span>
        </div>
        <div class="mt-2" style="font-size: 0.85rem;">
          <div><strong>${bus.speed}</strong> km/h</div>
          <div class="text-muted text-truncate" style="max-width: 150px;">${bus.address || 'Locating...'}</div>
        </div>
      </div>
    `;
  }).join('');
}

/**
 * Select a bus and highlight on map
 */
function selectBus(imei, busData) {
  selectedBusImei = imei;

  // Update marker size
  if (busMarkers[imei]) {
    busMarkers[imei].setIcon(L.divIcon({
      html: `
        <div style="
          width: 40px;
          height: 40px;
          background: ${busData.isMoving ? '#ef4444' : '#059669'};
          border: 4px solid #fbbf24;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          box-shadow: 0 4px 12px rgba(0,0,0,0.4);
        ">
          <i style="color: white; font-size: 16px;" class="bi bi-bus-front-fill"></i>
        </div>
      `,
      iconSize: [40, 40],
    }));

    // Pan to selected bus
    map.panTo(busMarkers[imei].getLatLng());
  }

  // Update bus info panel
  updateBusInfoPanel(busData);

  // Highlight in list
  document.querySelectorAll('.bus-list-item').forEach(item => {
    item.classList.remove('active');
  });
  const activeItem = document.querySelector(`.bus-list-item[onclick*="${imei}"]`);
  if (activeItem) activeItem.classList.add('active');
}

/**
 * Update bus info panel with details
 */
function updateBusInfoPanel(bus) {
  const panel = document.getElementById('bus-info-panel');
  if (!panel) return;

  const busName = (() => {
    if (window.busRegistry && Array.isArray(window.busRegistry)) {
      const found = window.busRegistry.find(b => b[1] === bus.imei);
      return found ? found[0] : bus.imei;
    }
    return bus.imei;
  })();

  const etaHtml = calculateETA(bus);

  panel.innerHTML = `
    <div class="card shadow-lg">
      <div class="card-header bg-primary text-white">
        <h5 class="mb-0">
          <i class="bi bi-bus-front-fill"></i> ${busName}
        </h5>
      </div>
      <div class="card-body">
        <div class="row g-3">
          <div class="col-6">
            <div class="small text-muted">IMEI</div>
            <div class="fw-600">${bus.imei}</div>
          </div>
          <div class="col-6">
            <div class="small text-muted">SPEED</div>
            <div class="fw-600">${bus.speed} km/h</div>
          </div>
          <div class="col-12">
            <div class="small text-muted">STATUS</div>
            <div class="fw-600">
              ${bus.isMoving ? '<span class="badge bg-danger">Moving</span>' : '<span class="badge bg-success">Stationary</span>'}
            </div>
          </div>
          <div class="col-12">
            <div class="small text-muted">ADDRESS</div>
            <div>${bus.address || 'Locating...'}</div>
          </div>
          ${etaHtml ? `<div class="col-12">${etaHtml}</div>` : ''}
          <div class="col-12">
            <div class="small text-muted">LAST UPDATE</div>
            <div id="bus-data-timestamp">Just now</div>
          </div>
        </div>
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
    const distance = latLng.distanceTo(L.latLng(bus.latitude, bus.longitude));
    if (distance < minDistance) {
      minDistance = distance;
      nearest = { name, distance, latlng: latLng };
    }
  });

  if (!nearest || nearest.distance <= 100) return '';

  // Simple ETA: distance / speed (in hours) * 60 (to minutes)
  const speedMs = bus.speed / 3.6; // km/h to m/s
  const etaSeconds = nearest.distance / speedMs;
  const etaMinutes = Math.round(etaSeconds / 60);

  return `
    <div class="small text-muted">ETA to ${nearest.name}</div>
    <div class="fw-600">${etaMinutes} minutes (${Math.round(nearest.distance / 1000)} km)</div>
  `;
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
      (window.busRegistry?.find(b => b[1] === bus.imei)?.[0] || bus.imei),
      bus.imei,
      bus.latitude,
      bus.longitude,
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

// Store bus data on markers for export
function updateBusMarker(bus) {
  const { imei, latitude, longitude, speed, isMoving, address } = bus;

  if (!imei || isNaN(latitude) || isNaN(longitude)) return;

  if (busMarkers[imei]) {
    map.removeLayer(busMarkers[imei]);
  }

  const iconColor = isMoving ? '#ef4444' : '#059669';
  const iconSize = selectedBusImei === imei ? 40 : 30;

  const busIcon = L.divIcon({
    html: `
      <div style="
        width: ${iconSize}px;
        height: ${iconSize}px;
        background: ${iconColor};
        border: 3px solid white;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      ">
        <i style="color: white; font-size: 14px;" class="bi bi-bus-front-fill"></i>
      </div>
    `,
    iconSize: [iconSize, iconSize],
    className: 'bus-marker',
  });

  const marker = L.marker([latitude, longitude], { icon: busIcon });
  marker.busData = bus; // Store bus data on marker
  marker.bindPopup(`
    <strong>Bus: ${imei}</strong><br/>
    Speed: ${speed} km/h<br/>
    Status: ${isMoving ? '🔴 Moving' : '🟢 Stationary'}<br/>
    Address: ${address || 'Locating...'}
  `);

  marker.on('click', () => selectBus(imei, bus));
  marker.addTo(map);
  busMarkers[imei] = marker;

  checkGeofenceEvents(bus);
}

// Export for global use
/**
 * Recalculate the map's size after its container becomes visible.
 * The map is initialized inside a hidden tab-pane (display:none), so Leaflet
 * sizes it 0x0; without this call the map stays gray when the tab opens.
 */
function refreshMapSize() {
  if (map) setTimeout(() => map.invalidateSize(), 50);
}

window.BusTracking = {
  initBusMap,
  stopBusTracking,
  exportBusData,
  selectBus,
  refreshMapSize,
};
