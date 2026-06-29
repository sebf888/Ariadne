'use strict';

/* Strait of Hormuz live ship map — front-end.
 * Polls /api/ships (server proxy to the store) and renders rotated vessel
 * markers on a Leaflet map, coloured by a selectable "view" (type / age /
 * activity). The legend doubles as the live key + per-category filter. */

const REFRESH_MS = 30000;
const TRAIL_HOURS = 24;

// AIS navigational status codes -> human label.
const NAV_STATUS = {
  0: 'Under way (engine)', 1: 'At anchor', 2: 'Not under command',
  3: 'Restricted manoeuvrability', 4: 'Constrained by draught', 5: 'Moored',
  6: 'Aground', 7: 'Fishing', 8: 'Under way (sailing)', 9: 'Reserved (HSC)',
  10: 'Reserved (WIG)', 11: 'Towing astern', 12: 'Pushing ahead',
  14: 'AIS-SART', 15: 'Undefined',
};

// --- Classifiers (each maps a vessel to a category key) ---------------------

function typeBucket(v) {
  const t = String(v.type || '').toLowerCase();
  if (t.includes('tanker')) return 'tanker';
  if (t.includes('cargo')) return 'cargo';
  if (t.includes('passenger')) return 'passenger';
  if (t.includes('tug') || t.includes('pilot') || t.includes('military') ||
      t.includes('law') || t.includes('special') || t.includes('search')) return 'special';
  return 'other';
}

function ageBucket(v) {
  if (!v.ts) return 'old';
  const mins = (Date.now() - new Date(v.ts).getTime()) / 60000;
  if (Number.isNaN(mins)) return 'old';
  if (mins < 15) return 'fresh';
  if (mins < 60) return 'recent';
  if (mins < 360) return 'stale';
  return 'old';
}

function statusBucket(v) {
  if (v.status === 1 || v.status === 5) return 'anchored';
  if (v.status === 0 || v.status === 8 || (v.sog != null && v.sog > 0.5)) return 'underway';
  return 'inactive';
}

// --- Dimensions -------------------------------------------------------------
// Each dimension is both a "colour by" option and an independent filter group.
// Filters across dimensions stack (AND); colour is driven by `colorMode`.

const DIMENSIONS = {
  // Muted, desaturated palette: categories stay distinguishable on the map
  // while the surrounding UI is strictly greyscale.
  type: {
    label: 'Type',
    classify: typeBucket,
    categories: [
      { key: 'cargo', color: '#7fa8a0', label: 'Cargo' },
      { key: 'tanker', color: '#c2a878', label: 'Tanker' },
      { key: 'passenger', color: '#7f9bb5', label: 'Passenger' },
      { key: 'special', color: '#b58a8a', label: 'Tug / Special' },
      { key: 'other', color: '#9a9a9a', label: 'Other / Unknown' },
    ],
  },
  age: {
    label: 'Report age',
    classify: ageBucket,
    categories: [
      { key: 'fresh', color: '#8fae8f', label: '< 15 min' },
      { key: 'recent', color: '#c2b87a', label: '15–60 min' },
      { key: 'stale', color: '#c29a72', label: '1–6 h' },
      { key: 'old', color: '#c28080', label: '> 6 h' },
    ],
  },
  status: {
    label: 'Activity',
    classify: statusBucket,
    categories: [
      { key: 'underway', color: '#7fa8a0', label: 'Under way' },
      { key: 'anchored', color: '#c2a878', label: 'Anchored / moored' },
      { key: 'inactive', color: '#9a9a9a', label: 'Other / unknown' },
    ],
  },
};

const DIM_KEYS = Object.keys(DIMENSIONS);

function categoryOf(v, dim) {
  return DIMENSIONS[dim].classify(v);
}
function colorOf(v) {
  const cat = DIMENSIONS[colorMode].classify(v);
  const c = DIMENSIONS[colorMode].categories.find((x) => x.key === cat);
  return c ? c.color : '#9a9a9a';
}

// --- Marker rendering -------------------------------------------------------

function headingOf(v) {
  if (v.hdt != null && v.hdt !== 511) return v.hdt;
  return v.cog != null ? v.cog : null;
}

// Canvas-rendered vessel marker. At Gulf scale there are thousands of vessels;
// one DOM node each (the old L.divIcon) made pan/zoom crawl. A single shared
// L.canvas renderer draws them all in one paint. We subclass L.CircleMarker so
// projection, bounds and click hit-testing (a circle of `radius`) come for free,
// and override _updatePath to draw a heading triangle (or a dot if no heading)
// straight to the canvas context. Leaflet 1.9.4's L.Canvas._draw() calls each
// layer's _updatePath() with _drawing=true, so this hooks in cleanly.
const ShipMarker = L.CircleMarker.extend({
  _updatePath() {
    const r = this._renderer;
    if (!r._drawing || this._empty()) return;
    const ctx = r._ctx;
    const p = this._point;
    const hd = this.options.heading;
    const rad = this.options.radius;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.beginPath();
    if (hd != null) {
      ctx.rotate((hd * Math.PI) / 180);
      ctx.moveTo(0, -rad);            // nose
      ctx.lineTo(rad * 0.66, rad);    // back-right
      ctx.lineTo(0, rad * 0.5);       // tail notch
      ctx.lineTo(-rad * 0.66, rad);   // back-left
      ctx.closePath();
    } else {
      ctx.arc(0, 0, rad * 0.7, 0, Math.PI * 2);
    }
    ctx.fillStyle = this.options.fillColor;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#161616';
    ctx.stroke();
    ctx.restore();
  },
});

// Style "fingerprint" so render()/restyle() only redraw a marker when its colour
// or heading actually changed (avoids thousands of redraws every 30s refresh).
function styleKey(v) {
  return `${colorOf(v)}|${headingOf(v)}`;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function fmtEta(eta) {
  if (!eta) return '—';
  const d = new Date(eta);
  return Number.isNaN(d.getTime()) ? esc(eta) : d.toUTCString().replace(' GMT', ' UTC');
}

function fmtAge(ts) {
  if (!ts) return '—';
  const mins = (Date.now() - new Date(ts).getTime()) / 60000;
  if (Number.isNaN(mins)) return '—';
  if (mins < 1) return 'just now';
  if (mins < 60) return `${Math.round(mins)} min ago`;
  if (mins < 1440) return `${(mins / 60).toFixed(1)} h ago`;
  return `${Math.floor(mins / 1440)} d ago`;
}

function popupHtml(v) {
  const rows = [
    ['MMSI', v.mmsi],
    ['IMO', v.imo || '—'],
    ['Type', v.type || '—'],
    ['Flag', v.flag || '—'],
    ['Speed', v.sog != null ? `${v.sog} kn` : '—'],
    ['Course', v.cog != null ? `${v.cog}°` : '—'],
    ['Heading', v.hdt != null && v.hdt !== 511 ? `${v.hdt}°` : '—'],
    ['Status', NAV_STATUS[v.status] || (v.status != null ? `Code ${v.status}` : '—')],
    ['Destination', v.dest || '—'],
    ['ETA', fmtEta(v.eta)],
    ['Position', `${(+v.lat).toFixed(4)}, ${(+v.lng).toFixed(4)}`],
    ['Last report', `${fmtAge(v.ts)}`],
  ];
  return (
    `<h3>${esc(v.name || 'Unknown vessel')}</h3><table>` +
    rows.map(([k, val]) => `<tr><td class="k">${esc(k)}</td><td>${esc(val)}</td></tr>`).join('') +
    `</table>`
  );
}

function extractVessels(json) {
  if (Array.isArray(json)) return json;
  for (const key of ['data', 'vessels', 'results', 'items']) {
    if (Array.isArray(json[key])) return json[key];
  }
  return [];
}

// --- State ------------------------------------------------------------------

let map;
const markers = new Map();           // id -> L.marker (carries .vessel)
let colorMode = 'type';              // which dimension drives marker colour
// Independent, stackable filters: one active-set per dimension (AND across).
const activeFilters = {};
for (const dim of DIM_KEYS) activeFilters[dim] = new Set(DIMENSIONS[dim].categories.map((c) => c.key));
let searchQuery = '';

// Dashboard timeframes: one window drives the snapshot cells (cordon, flow,
// integrity, storage, anomalies); trendDays drives the day-by-day charts
// (activity, run-rate). Both are user-selectable in the Analytics header.
let dashHours = 24;
let trendDays = 14;
function fmtWin(h) { return (h >= 72 && h % 24 === 0) ? `${h / 24} d` : `${h} h`; }
function setDashLabels() {
  document.querySelectorAll('.win').forEach((e) => { e.textContent = fmtWin(dashHours); });
  document.querySelectorAll('.trend').forEach((e) => { e.textContent = `${trendDays} d`; });
}

// Trail state: one selected vessel's track at a time.
let selectedMmsi = null;
let trailLayer = null;
let trailPoints = [];

// "All tracks" overlay: a filtered, lightweight background layer.
const ALL_TRACKS_HOURS = 12;
let allTracksOn = false;
let allTracksLayer = null;
let allTracksData = new Map();        // mmsi(string) -> [{lat,lng,ts}]

// Track-density heatmap overlay: where ships actually travel. Built from the
// same /api/tracks data, but densified along each leg so transit lanes (sparse,
// fast AIS reports) read as continuous paths rather than scattered dots.
let heatmapHours = 24;                // selectable timeframe (server caps at 72)
let heatWeight = 'density';           // density | speed | dwell — what each sample contributes
let heatmapOn = false;
let heatLayer = null;
let heatTracksData = new Map();       // mmsi(string) -> [{lat,lng,ts,sog}]
// `tolerance` widens the canvas hit area so the thin (1.5px) tracks are easy to
// click — clicking a track selects its vessel, exactly like its marker.
const tracksRenderer = L.canvas({ padding: 0.5, tolerance: 6 }); // fast for many polylines
// `tolerance` enlarges the click hit-area (radius + tolerance) without changing
// the drawn marker size — easier to tap/click a vessel.
const shipsRenderer = L.canvas({ padding: 0.5, tolerance: 6 });  // all vessel markers, one paint

// --- Init -------------------------------------------------------------------

async function init() {
  let bbox = { lat_min: 25.5, lat_max: 27.2, long_min: 54.5, long_max: 57.6 };
  let gates = null;
  let tiles = null;
  try {
    const cfg = await (await fetch('/api/config')).json();
    if (cfg.bbox) bbox = cfg.bbox;
    if (cfg.gates) gates = cfg.gates;
    if (Array.isArray(cfg.tiles) && cfg.tiles.length) tiles = cfg.tiles;
  } catch (_) { /* defaults */ }

  // When a tile grid is configured, frame the whole AOI (the union of tiles);
  // otherwise frame the single bbox. (Initial view only — no ingestion effect.)
  const frame = tiles
    ? [[Math.min(...tiles.map(t => t.lat_min)), Math.min(...tiles.map(t => t.long_min))],
       [Math.max(...tiles.map(t => t.lat_max)), Math.max(...tiles.map(t => t.long_max))]]
    : [[bbox.lat_min, bbox.long_min], [bbox.lat_max, bbox.long_max]];
  map = L.map('map', { zoomControl: true }).fitBounds(frame);

  const darkBase = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap &copy; CARTO', maxZoom: 19,
  }).addTo(map);
  const osmBase = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap', maxZoom: 19,
  });
  const seamarks = L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
    maxZoom: 18, opacity: 0.9, attribution: '&copy; OpenSeaMap',
  }).addTo(map);

  L.control.layers(
    { 'Dark': darkBase, 'OSM (labels)': osmBase },
    { 'Seamarks (OpenSeaMap)': seamarks },
    { collapsed: true, position: 'topright' }
  ).addTo(map);

  // Two-gate cordon — drawn so it can be eyeballed/tuned against the TSS lanes.
  if (gates) {
    const gateLabels = { W: 'Gate W · Gulf side', E: 'Gate E · Oman side' };
    for (const [key, g] of Object.entries(gates)) {
      L.polyline(
        [[g.a.lat, g.a.lng], [g.b.lat, g.b.lng]],
        { color: 'rgba(230, 230, 230, 0.6)', weight: 1.5, dashArray: '7 6', opacity: 0.9 }
      ).bindTooltip(gateLabels[key] || `Gate ${key}`, { sticky: true }).addTo(map);
    }
  }

  // Click on water: dismiss an open trail, else identify chart features here.
  map.on('click', onMapClick);

  buildFilters();
  wireControls();
  setDashLabels();
  setMode('type');
  refresh();
  refreshActivity();
  refreshCrossings();
  refreshFlow();
  refreshFlowSeries();
  refreshStorage();
  refreshDestinations();
  refreshIntegrity();
  setInterval(refresh, REFRESH_MS);
  setInterval(refreshActivity, REFRESH_MS);
  setInterval(refreshCrossings, REFRESH_MS);
  setInterval(refreshFlow, REFRESH_MS);
  setInterval(refreshFlowSeries, REFRESH_MS);
  setInterval(refreshStorage, REFRESH_MS);
  setInterval(refreshDestinations, REFRESH_MS);
  setInterval(refreshIntegrity, REFRESH_MS);

  // The map shares the viewport with the dashboard now — keep Leaflet sized.
  setTimeout(() => map.invalidateSize(), 0);
  window.addEventListener('resize', () => map.invalidateSize());
}

function wireControls() {
  document.querySelectorAll('#modes .seg button').forEach((b) => {
    b.addEventListener('click', () => setMode(b.dataset.mode));
  });
  const search = document.getElementById('search');
  search.addEventListener('input', () => {
    searchQuery = search.value.trim().toLowerCase();
    applyFilters();
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') zoomToVisible();
  });
  document.getElementById('alltracks-cb').addEventListener('change', (e) => {
    setAllTracks(e.target.checked);
  });
  document.getElementById('heatmap-cb').addEventListener('change', (e) => {
    setHeatmap(e.target.checked);
  });
  document.querySelectorAll('#heat-range button').forEach((b) => {
    b.addEventListener('click', () => {
      heatmapHours = Number(b.dataset.hours);
      document.querySelectorAll('#heat-range button').forEach((x) =>
        x.classList.toggle('active', x === b));
      if (heatmapOn) loadHeatmap(); // refetch the new window, then redraw
    });
  });
  document.querySelectorAll('#heat-weight button').forEach((b) => {
    b.addEventListener('click', () => {
      heatWeight = b.dataset.weight;
      document.querySelectorAll('#heat-weight button').forEach((x) =>
        x.classList.toggle('active', x === b));
      if (heatmapOn) drawHeatmap(); // re-weight from cache, no refetch
    });
  });
  // Global dashboard timeframe controls.
  document.querySelectorAll('#dash-window button').forEach((b) => {
    b.addEventListener('click', () => {
      dashHours = Number(b.dataset.hours);
      document.querySelectorAll('#dash-window button').forEach((x) =>
        x.classList.toggle('active', x === b));
      setDashLabels();
      refreshCrossings(); refreshFlow(); refreshIntegrity(); refreshStorage();
    });
  });
  document.querySelectorAll('#dash-trend button').forEach((b) => {
    b.addEventListener('click', () => {
      trendDays = Number(b.dataset.days);
      document.querySelectorAll('#dash-trend button').forEach((x) =>
        x.classList.toggle('active', x === b));
      setDashLabels();
      refreshActivity(); refreshFlowSeries();
    });
  });
  document.getElementById('darkspots-cb').addEventListener('change', (e) => {
    setDarkSpots(e.target.checked);
  });
  document.getElementById('sts-cb').addEventListener('change', (e) => {
    setStsClusters(e.target.checked);
  });
  // Integrity / watchlist rows that carry a position pan the map to it.
  for (const id of ['int-detail', 'wl-detail']) {
    document.getElementById(id).addEventListener('click', (e) => {
      const el = e.target.closest('.int-row.click');
      if (el) map.setView([+el.dataset.lat, +el.dataset.lng], 12);
    });
  }
  // Shadow-fleet score rows locate their hull when a position is known.
  document.getElementById('sf-detail').addEventListener('click', (e) => {
    const el = e.target.closest('.sf-row');
    if (el && el.dataset.lat) map.setView([+el.dataset.lat, +el.dataset.lng], 12);
  });
  // Floating-storage rows locate the parked tanker.
  document.getElementById('st-detail').addEventListener('click', (e) => {
    const el = e.target.closest('.st-row');
    if (el && el.dataset.lat) map.setView([+el.dataset.lat, +el.dataset.lng], 12);
  });
  // A crossing row locates its vessel on the map (if still on station).
  document.getElementById('tx-list').addEventListener('click', (e) => {
    const row = e.target.closest('.px-row');
    if (!row) return;
    const m = markers.get(String(row.dataset.mmsi));
    if (m) { map.setView(m.getLatLng(), 12); showTrail(m.vessel); }
  });
}

// --- All-tracks overlay -----------------------------------------------------

function setAllTracks(on) {
  allTracksOn = on;
  if (on) {
    if (!allTracksLayer) allTracksLayer = L.layerGroup().addTo(map);
    loadAllTracks();
  } else if (allTracksLayer) {
    allTracksLayer.clearLayers();
  }
}

async function loadAllTracks() {
  try {
    const json = await (await fetch(`/api/tracks?hours=${ALL_TRACKS_HOURS}`)).json();
    allTracksData = new Map(Object.entries(json.tracks || {}));
  } catch (_) {
    allTracksData = new Map();
  }
  drawAllTracks();
}

// Draw one lightweight polyline per *visible* vessel (filters apply), from
// cache. Cheap to call on filter/colour changes; canvas renderer keeps it fast.
function drawAllTracks() {
  if (!allTracksLayer) return;
  allTracksLayer.clearLayers();
  if (!allTracksOn) return;
  for (const [id, m] of markers) {
    if (!passes(m)) continue;
    const pts = allTracksData.get(id);
    if (!pts || pts.length < 2) continue;
    const line = L.polyline(pts.map((p) => [+p.lat, +p.lng]), {
      color: colorOf(m.vessel), weight: 1.5, opacity: 0.35,
      renderer: tracksRenderer, interactive: true,
    });
    // Clicking a track selects its vessel — same as clicking the ship marker.
    // Read the marker's latest vessel at click time (positions update on refresh).
    line.on('click', () => showTrail(m.vessel));
    line.addTo(allTracksLayer);
  }
}

// --- Track-density heatmap --------------------------------------------------

// Muted ramp that fits the greyscale theme: cool (teal) where traffic is light,
// warming through amber to red along the busiest lanes. Keys are 0..1 fractions.
const HEAT_GRADIENT = {
  0.2: '#3a6b6b', 0.4: '#7fa8a0', 0.6: '#c2b87a', 0.8: '#c29a72', 1.0: '#d06b6b',
};
// Densify legs to ~440 m spacing so fast transits aren't under-weighted, but
// drop legs longer than ~44 km (AIS gaps / position jumps shouldn't draw a line
// across the chart) and cap steps so one big leg can't dominate.
const HEAT_STEP_DEG = 0.004;
const HEAT_MAX_LEG_DEG = 0.4;
const HEAT_MAX_STEPS = 80;
const HEAT_SPEED_REF = 14;  // kn that reads as a "full" fast-lane sample
const HEAT_DWELL_REF = 3;   // kn below which a vessel counts as dwelling

// Per-sample weight under the active weighting. Density = pure traffic volume;
// Speed lights the fast transit lanes; Dwell lights where vessels sit still
// (anchorages, loitering, STS) — the inverse map.
function heatWeightFor(sog) {
  if (heatWeight === 'density') return 1;
  const s = sog == null ? null : +sog;
  if (heatWeight === 'speed') {
    return s == null ? 0.03 : Math.max(0.03, Math.min(1, s / HEAT_SPEED_REF));
  }
  return s == null ? 0 : Math.max(0, Math.min(1, 1 - s / HEAT_DWELL_REF)); // dwell
}

function setHeatmap(on) {
  heatmapOn = on;
  document.getElementById('heat-range').classList.toggle('on', on);
  document.getElementById('heat-weight').classList.toggle('on', on);
  if (on) {
    loadHeatmap();
  } else if (heatLayer) {
    map.removeLayer(heatLayer);
    heatLayer = null;
  }
}

async function loadHeatmap() {
  try {
    const json = await (await fetch(`/api/tracks?hours=${heatmapHours}`)).json();
    heatTracksData = new Map(Object.entries(json.tracks || {}));
  } catch (_) {
    heatTracksData = new Map();
  }
  drawHeatmap();
}

// Flatten every (optionally filtered) track into densified [lat, lng, weight]
// samples. Density does the rest: overlapping lanes accumulate into hot ridges.
function buildHeatPoints() {
  const pts = [];
  for (const [id, track] of heatTracksData) {
    // Respect the filter chips for vessels currently on screen; keep history for
    // hulls that have since left the live window (richer lane structure).
    const m = markers.get(id);
    if (m && !passes(m)) continue;
    if (!track || !track.length) continue;
    for (let i = 0; i < track.length; i++) {
      const p = track[i];
      pts.push([+p.lat, +p.lng, heatWeightFor(p.sog)]);
      if (i === 0) continue;
      const a = track[i - 1];
      const dLat = +p.lat - +a.lat;
      const dLng = +p.lng - +a.lng;
      const dist = Math.hypot(dLat, dLng);
      if (dist > HEAT_MAX_LEG_DEG || dist < HEAT_STEP_DEG) continue;
      // Interpolated samples inherit the leg's representative speed.
      const legSog = a.sog != null && p.sog != null ? (+a.sog + +p.sog) / 2
        : (p.sog != null ? +p.sog : a.sog);
      const w = heatWeightFor(legSog);
      const steps = Math.min(Math.floor(dist / HEAT_STEP_DEG), HEAT_MAX_STEPS);
      for (let s = 1; s < steps; s++) {
        const f = s / steps;
        pts.push([+a.lat + dLat * f, +a.lng + dLng * f, w]);
      }
    }
  }
  return pts;
}

function drawHeatmap() {
  if (!heatmapOn) return;
  const pts = buildHeatPoints();
  if (!heatLayer) {
    // Own pane below the ship markers (overlayPane=400) so vessels and tracks
    // stay legible on top; click-through so it never steals map/identify clicks.
    if (!map.getPane('heat')) {
      map.createPane('heat');
      map.getPane('heat').style.zIndex = 350;
      map.getPane('heat').style.pointerEvents = 'none';
    }
    heatLayer = L.heatLayer(pts, {
      radius: 14, blur: 20, max: 6, minOpacity: 0.18,
      maxZoom: 13, gradient: HEAT_GRADIENT, pane: 'heat',
    }).addTo(map);
  } else {
    heatLayer.setLatLngs(pts);
  }
}

// --- Dark-spot + STS overlays (driven by the /api/integrity payload) --------

// Both reuse the integrity summary the dashboard already polls every 30 s, so
// they add no fetches — just plot where the signals are.
let darkSpotsOn = false;
let darkSpotsLayer = null;
let stsClustersOn = false;
let stsClustersLayer = null;
let lastIntegrity = null;     // most recent /api/integrity payload, for the overlays

function setDarkSpots(on) {
  darkSpotsOn = on;
  if (on) {
    if (!darkSpotsLayer) darkSpotsLayer = L.layerGroup().addTo(map);
    drawDarkSpots();
  } else if (darkSpotsLayer) {
    darkSpotsLayer.clearLayers();
  }
}

function drawDarkSpots() {
  if (!darkSpotsLayer) return;
  darkSpotsLayer.clearLayers();
  if (!darkSpotsOn || !lastIntegrity) return;
  for (const d of lastIntegrity.dark.open) {
    if (d.lat == null || d.lng == null) continue;
    // Dashed red ring at the last fix before the vessel went quiet.
    L.circleMarker([+d.lat, +d.lng], {
      radius: 8, color: '#c28080', weight: 1.5, opacity: 0.9,
      fillColor: '#c28080', fillOpacity: 0.12, dashArray: '3 3',
    }).bindPopup(
      `<h3>${esc(d.name || 'MMSI ' + d.mmsi)}</h3>` +
      `<div class="ident">Went dark ${fmtMin(d.minutesDark)} ago · ${esc(d.type || '—')}</div>`
    ).addTo(darkSpotsLayer);
  }
}

function setStsClusters(on) {
  stsClustersOn = on;
  if (on) {
    if (!stsClustersLayer) stsClustersLayer = L.layerGroup().addTo(map);
    drawStsClusters();
  } else if (stsClustersLayer) {
    stsClustersLayer.clearLayers();
  }
}

function drawStsClusters() {
  if (!stsClustersLayer) return;
  stsClustersLayer.clearLayers();
  if (!stsClustersOn || !lastIntegrity) return;
  for (const p of lastIntegrity.sts.active) {
    if (p.lat == null || p.lng == null) continue;
    const r = Math.min(15, 6 + Math.log2(1 + p.durMin / 30) * 3); // grow with episode length
    const dist = p.distM != null ? ` · ${p.distM} m apart` : '';
    L.circleMarker([+p.lat, +p.lng], {
      radius: r, color: '#7fa8a0', weight: 1.5, opacity: 0.9,
      fillColor: '#7fa8a0', fillOpacity: 0.15,
    }).bindPopup(
      `<h3>STS candidate</h3><div class="ident">` +
      `${esc(p.nameA || 'MMSI ' + p.a)} ↔ ${esc(p.nameB || 'MMSI ' + p.b)}<br>` +
      `held ${fmtMin(p.durMin)}${dist}</div>`
    ).addTo(stsClustersLayer);
  }
}

// "Colour by" only changes the visual encoding — it does NOT touch filters.
function setMode(mode) {
  if (!DIMENSIONS[mode]) return;
  colorMode = mode;
  document.querySelectorAll('#modes .seg button').forEach((b) =>
    b.classList.toggle('active', b.dataset.mode === mode));
  // Mark which filter group currently drives colour.
  document.querySelectorAll('#legend .fgroup').forEach((g) =>
    g.classList.toggle('colouring', g.dataset.dim === mode));
  restyle();
  // Recolour an open trail to match the new colour dimension (no refetch).
  if (selectedMmsi != null) {
    const m = markers.get(String(selectedMmsi));
    if (m) drawTrail(m.vessel);
  }
}

// Render all dimensions as independent, stackable filter groups of chips.
function buildFilters() {
  const wrap = document.getElementById('legend-groups');
  wrap.innerHTML = '';
  for (const dim of DIM_KEYS) {
    const d = DIMENSIONS[dim];
    const group = document.createElement('div');
    group.className = 'fgroup';
    group.dataset.dim = dim;

    const title = document.createElement('div');
    title.className = 'fgroup-title';
    title.textContent = d.label;
    group.appendChild(title);

    const rowEl = document.createElement('div');
    rowEl.className = 'frow';
    for (const c of d.categories) {
      const chip = document.createElement('span');
      chip.className = 'chip' + (activeFilters[dim].has(c.key) ? '' : ' off');
      chip.dataset.dim = dim;
      chip.dataset.cat = c.key;
      chip.innerHTML =
        `<span class="dot" style="background:${c.color}"></span>` +
        `${c.label} <span class="cnt"></span>`;
      chip.addEventListener('click', () => {
        const set = activeFilters[dim];
        if (set.has(c.key)) set.delete(c.key);
        else set.add(c.key);
        chip.classList.toggle('off', !set.has(c.key));
        applyFilters();
      });
      rowEl.appendChild(chip);
    }
    group.appendChild(rowEl);
    wrap.appendChild(group);
  }
}

// --- Data + filtering -------------------------------------------------------

async function refresh() {
  const statusEl = document.getElementById('status');
  try {
    const res = await fetch('/api/ships');
    if (!res.ok) throw new Error(`server returned ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(json.error);
    const vessels = extractVessels(json).filter((v) => v && v.lat != null && v.lng != null);
    render(vessels);
    // Keep an open trail current (and drop it if the vessel left the area).
    if (selectedMmsi != null) {
      const m = markers.get(String(selectedMmsi));
      if (m) showTrail(m.vessel);
      else clearTrail();
    }
    if (allTracksOn) loadAllTracks(); // refresh the overlay with new data
    if (heatmapOn) loadHeatmap();     // refresh the heatmap with new data
    statusEl.classList.remove('err');
    statusEl.innerHTML =
      `Updated ${new Date().toLocaleTimeString()} · ` +
      `<a class="refresh" onclick="window.__refresh()">refresh now</a>`;
  } catch (err) {
    statusEl.classList.add('err');
    statusEl.textContent = `Error: ${err.message}`;
  }
}

function fmtMin(m) {
  if (m == null) return '—';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${Math.round(m % 60)}m`;
}

async function refreshCrossings() {
  try {
    const s = await (await fetch(`/api/crossings?hours=${dashHours}`)).json();
    const set = (id, v) => { document.getElementById(id).textContent = v; };
    const c = s.completed;
    set('tx-out', c.outbound.total);
    set('tx-in', c.inbound.total);
    set('tx-out-t', c.outbound.tankers ? `${c.outbound.tankers} tankers` : '');
    set('tx-in-t', c.inbound.tankers ? `${c.inbound.tankers} tankers` : '');
    set('tx-median', `Median transit: ${fmtMin(c.medianTransitMin)}`);
    set('tx-gross', `Gross crossings: ${s.gross.outbound} out / ${s.gross.inbound} in`);

    // Anomaly flags — what the cordon exists to surface.
    const flags = [];
    if (s.uTurns) flags.push(`${s.uTurns} U-turn${s.uTurns > 1 ? 's' : ''}`);
    if (c.slow) flags.push(`${c.slow} slow transit${c.slow > 1 ? 's' : ''}`);
    if (s.incomplete) flags.push(`${s.incomplete} incomplete (dark?)`);
    document.getElementById('tx-flags').innerHTML = flags.length
      ? flags.map((t) => `<span class="flag warn">${t}</span>`).join('')
      : '<span class="sub">none in window</span>';

    renderTransitDist(s.transit);
    renderPassages(s.passages || []);
  } catch (_) { /* leave previous values */ }
}

// Transit-time histogram + percentiles — a widening upper tail flags congestion.
function renderTransitDist(t) {
  const el = document.getElementById('tx-dist');
  const note = document.getElementById('tx-dist-note');
  if (!el) return;
  if (!t || !t.n) {
    el.innerHTML = '';
    if (note) note.textContent = 'no completed passages in window';
    return;
  }
  const max = Math.max(1, ...t.histogram.map((b) => b.count));
  const medBin = t.histogram.findIndex((b) => t.p50 != null && t.p50 >= b.from && t.p50 < b.to);
  el.innerHTML = t.histogram.map((b, i) => {
    const h = Math.max(2, Math.round((b.count / max) * 44));
    const cls = i === medBin ? 'bar p50' : 'bar';
    return `<span class="${cls}" style="height:${h}px" title="${b.from}–${b.to} min · ${b.count}"></span>`;
  }).join('');
  if (note) note.textContent =
    `p10 ${fmtMin(t.p10)} · p50 ${fmtMin(t.p50)} · p90 ${fmtMin(t.p90)} · n=${t.n}`;
}

// The individual vessels behind the cordon totals (newest first). Direction
// arrow matches the totals above: outbound = exports = →, inbound = ←.
const PASSAGES_SHOWN = 12;
function renderPassages(list) {
  const el = document.getElementById('tx-list');
  if (!el) return;
  if (!list.length) {
    el.innerHTML = '<span class="sub">no completed passages in window</span>';
    return;
  }
  const shown = list.slice(0, PASSAGES_SHOWN);
  const rows = shown.map((p) => {
    const arrow = p.direction === 'outbound' ? '→' : '←';
    const name = esc(p.name || `MMSI ${p.mmsi}`);
    const tkr = p.tanker ? '<span class="px-tkr">tanker</span>' : '';
    const t = p.transitMin != null ? `${fmtMin(p.transitMin)}${p.slow ? ' · slow' : ''}` : '';
    return `<div class="px-row" data-mmsi="${esc(p.mmsi)}">` +
      `<span class="px-dir">${arrow}</span>` +
      `<span class="px-name">${name}</span>${tkr}` +
      `<span class="px-t">${t}</span></div>`;
  });
  if (list.length > shown.length) rows.push(`<div class="px-more">+${list.length - shown.length} more</div>`);
  el.innerHTML = rows.join('');
}

function fmtBbl(n) {
  if (n == null) return '—';
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

async function refreshFlow() {
  try {
    const f = await (await fetch(`/api/flow?hours=${dashHours}`)).json();
    const set = (id, v) => { document.getElementById(id).textContent = v; };
    set('flow-out-bbl', fmtBbl(f.outbound.barrels));
    set('flow-in-bbl', fmtBbl(f.inbound.barrels));
    set('flow-n', `From ${f.outbound.tankerPassages} outbound / ${f.inbound.tankerPassages} inbound tanker passages`);
    set('flow-note', f.assumptions ? `≈ ${f.assumptions.capacity}` : '');
  } catch (_) { /* leave previous values */ }
}

// --- Gulf activity overview (top-line counts + daily crossings) -------------

async function refreshActivity() {
  try {
    renderActivity(await (await fetch(`/api/activity?days=${trendDays}`)).json());
  } catch (_) { /* leave previous values */ }
}

function renderActivity(a) {
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  if (!a || a.error) return;
  set('ga-ships', a.present.ships);
  set('ga-tankers', a.present.tankers);
  const series = a.series || [];
  const last = series[series.length - 1];
  set('ga-today', last ? last.inbound + last.outbound : 0);
  const el = document.getElementById('ga-bars');
  if (!el) return;
  if (!series.length) { el.innerHTML = ''; set('ga-note', ''); return; }
  const H = 56;
  const max = Math.max(1, ...series.map((s) => s.inbound + s.outbound));
  const md = (x) => new Date(x.date).toISOString().slice(5, 10);
  el.innerHTML = series.map((s) => {
    const o = Math.round((s.outbound / max) * H);
    const i = Math.round((s.inbound / max) * H);
    return `<span class="col" title="${md(s)} · ${s.outbound} out / ${s.inbound} in">` +
      `<span class="in" style="height:${i}px"></span>` +
      `<span class="out" style="height:${o}px"></span></span>`;
  }).join('');
  set('ga-note', `completed passages/day · outbound + inbound · ${md(series[0])}–${md(last)}`);
}

// --- Export run-rate (time series + z-score) --------------------------------

async function refreshFlowSeries() {
  try {
    const f = await (await fetch(`/api/flowseries?days=${trendDays}&bucket=day`)).json();
    renderRunRate(f);
  } catch (_) { /* leave previous values */ }
}

function renderRunRate(f) {
  const spark = document.getElementById('rr-spark');
  const note = document.getElementById('rr-note');
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  if (!f || !f.series || !f.series.length) {
    if (spark) spark.innerHTML = '';
    set('rr-latest', '—'); set('rr-note', ''); return;
  }
  const vals = f.series.map((s) => s.outbound);
  const max = Math.max(1, ...vals);
  const W = 240, H = 44, n = vals.length;
  const X = (i) => (n > 1 ? (i / (n - 1)) * W : 0);
  const Y = (v) => H - (v / max) * (H - 4) - 2;
  const line = vals.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
  const area = `M0,${H} ${vals.map((v, i) => `L${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ')} L${W},${H} Z`;
  const st = f.outbound || {};
  const hot = Math.abs(st.z || 0) >= 2;
  spark.innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">` +
    `<path class="area" d="${area}"/><path class="line" d="${line}"/>` +
    `<circle class="last${hot ? ' hot' : ''}" cx="${X(n - 1).toFixed(1)}" cy="${Y(vals[n - 1]).toFixed(1)}" r="2.5"/>` +
    `</svg>`;
  set('rr-latest', fmtBbl(st.latest));
  const z = st.z || 0;
  set('rr-note', `trailing avg ${fmtBbl(st.trail)} bbl/day · z=${z > 0 ? '+' : ''}${z}${hot ? ' · anomaly' : ''}`);
}

// --- Floating storage / anchorage queues ------------------------------------

async function refreshStorage() {
  try {
    renderStorage(await (await fetch(`/api/storage?hours=${dashHours}`)).json());
  } catch (_) { /* leave previous values */ }
}

function renderStorage(s) {
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  if (!s || s.error) return;
  set('st-parked', s.parked);
  set('st-laden', s.ladenCount);
  set('st-bbl', fmtBbl(s.barrels));
  const el = document.getElementById('st-detail');
  if (!s.vessels || !s.vessels.length) {
    el.innerHTML = '<span class="sub">no parked tankers in window</span>';
  } else {
    el.innerHTML = s.vessels.slice(0, 8).map((v) => {
      const loc = (v.lat != null && v.lng != null) ? ` data-lat="${v.lat}" data-lng="${v.lng}"` : '';
      const laden = v.barrels != null ? `<span class="st-badge">${fmtBbl(v.barrels)} bbl</span>` : '';
      return `<div class="st-row"${loc}><span class="st-name">${vesselLabel(v)}</span>${laden}` +
        `<span class="st-meta">${v.parkedHours}h · ${v.spanKm}km</span></div>`;
    }).join('');
  }
  const q = (s.queues || []).length;
  set('st-note',
    `${s.parked} parked tanker${s.parked === 1 ? '' : 's'}` +
    (q ? ` · ${q} queue${q > 1 ? 's' : ''} (≥2 clustered)` : '') +
    ` · laden via draught where known · estimate`);
}

// --- Outbound destinations (origin-destination) -----------------------------

async function refreshDestinations() {
  try {
    renderDestinations(await (await fetch('/api/destinations')).json());
  } catch (_) { /* leave previous values */ }
}

function renderDestinations(d) {
  const el = document.getElementById('dest-detail');
  const note = document.getElementById('dest-note');
  if (!el) return;
  if (!d || !d.total) {
    el.innerHTML = '<span class="sub">no declared destinations on station</span>';
    if (note) note.textContent = '';
    return;
  }
  const max = Math.max(1, ...d.regions.map((r) => r.count));
  el.innerHTML = d.regions.map((r) => {
    const pct = Math.round((r.count / max) * 100);
    return `<div class="reg-row"><span class="reg-name">${esc(r.region)}</span>` +
      `<span class="reg-bar"><i style="width:${pct}%"></i></span>` +
      `<span class="reg-cnt">${r.count}</span></div>`;
  }).join('');
  if (note) note.textContent =
    `${d.total} tanker${d.total === 1 ? '' : 's'} with a declared destination · AIS dest field, noisy`;
}

// --- Integrity layer (Phase 4) ----------------------------------------------

// Thin monochrome line glyphs (inherit currentColor) — no emoji.
const ICON = (body) =>
  `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor"` +
  ` stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const INT_ICONS = {
  dark: ICON('<circle cx="7" cy="7" r="4.6" stroke-dasharray="2 2"/>'),          // gone quiet
  sts:  ICON('<circle cx="3.6" cy="7" r="1.9"/><circle cx="10.4" cy="7" r="1.9"/><line x1="5.5" y1="7" x2="8.5" y2="7"/>'), // pair held close
  hop:  ICON('<path d="M2 4.5 H10.5 M8.7 2.7 L10.5 4.5 L8.7 6.3"/><path d="M12 9.5 H3.5 M5.3 7.7 L3.5 9.5 L5.3 11.3"/>'),     // reflag / IMO swap
  jump: ICON('<polyline points="2,10 5.5,4 8,8.5 12,3.5"/>'),                    // impossible speed
  id:   ICON('<rect x="2" y="3.4" width="10" height="7.2" rx="1"/><line x1="4" y1="6" x2="6.4" y2="6"/><line x1="4" y1="8.2" x2="9" y2="8.2"/>'), // identity card
  sanc: ICON('<circle cx="7" cy="7" r="4.8"/><line x1="3.6" y1="3.6" x2="10.4" y2="10.4"/>'), // prohibition / designated
};

function vesselLabel(o) {
  return esc(o.name || `MMSI ${o.mmsi}`);
}

function intRow(icon, html, lat, lng) {
  const click = lat != null && lng != null;
  const cls = click ? 'int-row click' : 'int-row';
  const pos = click ? ` data-lat="${lat}" data-lng="${lng}"` : '';
  return `<div class="${cls}"${pos}><span class="int-ic">${icon}</span><span>${html}</span></div>`;
}

async function refreshIntegrity() {
  try {
    const s = await (await fetch(`/api/integrity?hours=${dashHours}`)).json();
    if (s.error) return;
    lastIntegrity = s;
    const set = (id, v) => { document.getElementById(id).textContent = v; };
    set('int-dark', s.dark.openCount);
    set('int-sts', s.sts.count);
    set('int-spoof', s.spoofing.identityCount);
    set('int-jump', s.spoofing.jumps.length);

    const lines = [];
    for (const d of s.dark.open.slice(0, 4)) {
      lines.push(intRow(INT_ICONS.dark, `${vesselLabel(d)} <span class="sub">dark ${fmtMin(d.minutesDark)}</span>`, d.lat, d.lng));
    }
    for (const p of s.sts.active.slice(0, 4)) {
      const dist = p.distM != null ? ` · ${p.distM} m` : '';
      lines.push(intRow(INT_ICONS.sts,
        `${vesselLabel({ name: p.nameA, mmsi: p.a })} ↔ ${vesselLabel({ name: p.nameB, mmsi: p.b })} ` +
        `<span class="sub">${fmtMin(p.durMin)}${dist}</span>`, p.lat, p.lng));
    }
    for (const h of (s.spoofing.hops || []).slice(0, 3)) {
      const bits = [];
      if (h.imoChanges) bits.push(`IMO changed ×${h.imoChanges}`);
      if (h.flagHops) bits.push(`reflagged ×${h.flagHops}${h.latestFlag ? ` → ${esc(h.latestFlag)}` : ''}`);
      lines.push(intRow(INT_ICONS.hop, `${vesselLabel(h)} <span class="sub">${bits.join(' · ')}</span>`));
    }
    for (const j of s.spoofing.jumps.slice(0, 3)) {
      lines.push(intRow(INT_ICONS.jump, `${vesselLabel(j)} <span class="sub">jump ${Math.round(j.maxKn)} kn / ${Math.round(j.maxKm)} km</span>`));
    }
    for (const idf of s.spoofing.identity.slice(0, 4)) {
      lines.push(intRow(INT_ICONS.id, `${vesselLabel(idf)} <span class="sub">${esc(idf.flags.join(', '))}</span>`));
    }

    document.getElementById('int-detail').innerHTML =
      lines.length ? lines.join('') : '<span class="sub">no integrity signals in window</span>';
    const hopCount = s.spoofing.hopCount || 0;
    set('int-note',
      `${s.spoofing.identityCount} identity flag${s.spoofing.identityCount === 1 ? '' : 's'} on station` +
      (hopCount ? ` · ${hopCount} reflag/IMO-change` : '') +
      ` · heuristic signals, not adjudications`);

    // Row 2 — sanctions exposure, fed from the same payload (no extra fetch).
    renderWatchlist(s.watchlist);
    renderShadowFleet(s.shadowFleet);

    // Map overlays driven by the same payload (no extra fetch).
    if (darkSpotsOn) drawDarkSpots();
    if (stsClustersOn) drawStsClusters();
  } catch (_) { /* leave previous values */ }
}

// Designated-vessel watchlist matches currently on station. Empty watchlist ⇒
// a prompt to populate it; the matcher keys on IMO first, then MMSI.
function renderWatchlist(w) {
  if (!w) return;
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  set('wl-onstation', w.onStation);
  set('wl-size', w.size);
  const el = document.getElementById('wl-detail');
  const note = document.getElementById('wl-note');
  if (!w.size) {
    el.innerHTML = '<span class="sub">Watchlist not populated.</span>';
    note.textContent = 'Add designated IMO/MMSI to data/sanctions.json — matched by IMO, then MMSI.';
    return;
  }
  if (!w.matches.length) {
    el.innerHTML = '<span class="sub">No designated vessels on station.</span>';
  } else {
    el.innerHTML = w.matches.map((m) => {
      const bits = [];
      if (m.imo) bits.push(`IMO ${esc(m.imo)}`);
      if (m.program) bits.push(esc(m.program));
      if (m.flag) bits.push(esc(m.flag));
      const sub = bits.length ? ` <span class="sub">${bits.join(' · ')}</span>` : '';
      const badge = `<span class="wl-flag">${m.matchedOn === 'imo' ? 'IMO' : 'MMSI'}</span>`;
      return intRow(INT_ICONS.sanc, `${vesselLabel(m)} ${badge}${sub}`, m.lat, m.lng);
    }).join('');
  }
  note.textContent =
    `${w.onStation} of ${w.size} designated vessel${w.size === 1 ? '' : 's'} present · ` +
    `exposure signal, not adjudication`;
}

// Hulls ranked by composite shadow-fleet score (noisy-OR of integrity tells).
// A score bar + the firing reasons; watchlisted hulls carry the red accent.
function renderShadowFleet(sf) {
  if (!sf) return;
  const el = document.getElementById('sf-detail');
  const note = document.getElementById('sf-note');
  if (!sf.scored || !sf.scored.length) {
    el.innerHTML = '<span class="sub">no flagged vessels in window</span>';
    note.textContent = '';
    return;
  }
  el.innerHTML = sf.scored.map((v) => {
    const pct = Math.round(v.score * 100);
    const loc = (v.lat != null && v.lng != null) ? ` data-lat="${v.lat}" data-lng="${v.lng}"` : '';
    return `<div class="sf-row${v.watchlisted ? ' wl' : ''}"${loc}>` +
      `<span class="sf-score">${v.score.toFixed(2)}</span>` +
      `<span class="sf-bar"><i style="width:${pct}%"></i></span>` +
      `<span class="sf-name">${vesselLabel(v)}</span>` +
      `<span class="sf-reasons">${v.reasons.map(esc).join(' · ')}</span></div>`;
  }).join('');
  note.textContent =
    `${sf.flaggedCount} hull${sf.flaggedCount === 1 ? '' : 's'} with signals · ` +
    `noisy-OR of integrity tells · heuristic prior, not adjudication`;
}

function render(vessels) {
  const seen = new Set();
  for (const v of vessels) {
    const id = v.mmsi != null ? String(v.mmsi) : `${v.lat},${v.lng}`;
    seen.add(id);
    let m = markers.get(id);
    if (m) {
      m.vessel = v;
      m.setLatLng([+v.lat, +v.lng]); // reprojects + redraws this marker
      const key = styleKey(v);
      if (key !== m._styleKey) {      // only repaint style when it actually changed
        m._styleKey = key;
        m.options.fillColor = colorOf(v);
        m.options.heading = headingOf(v);
        if (map.hasLayer(m)) m.redraw();
      }
    } else {
      m = new ShipMarker([+v.lat, +v.lng], {
        renderer: shipsRenderer, radius: 8, interactive: true,
        fillColor: colorOf(v), heading: headingOf(v),
      });
      m.vessel = v;
      m._styleKey = styleKey(v);
      // Popup content built lazily (only when opened), not for all N vessels.
      m.bindPopup(() => popupHtml(m.vessel));
      m.on('click', () => showTrail(m.vessel)); // reads latest vessel at click time
      markers.set(id, m);
    }
  }
  for (const [id, m] of markers) {
    if (!seen.has(id)) { map.removeLayer(m); markers.delete(id); }
  }
  applyFilters();
}

// Recolour all markers for the current mode (no new data), then re-filter.
function restyle() {
  for (const m of markers.values()) {
    m._styleKey = styleKey(m.vessel);
    m.options.fillColor = colorOf(m.vessel);
    m.options.heading = headingOf(m.vessel);
    if (map.hasLayer(m)) m.redraw(); // canvas coalesces these into one rAF paint
  }
  applyFilters();
}

function matchesSearch(v) {
  if (!searchQuery) return true;
  return `${v.name || ''} ${v.mmsi || ''} ${v.imo || ''}`.toLowerCase().includes(searchQuery);
}
// A vessel passes only if it's in an active category of EVERY dimension (AND),
// plus the search.
function passes(m) {
  for (const dim of DIM_KEYS) {
    if (!activeFilters[dim].has(categoryOf(m.vessel, dim))) return false;
  }
  return matchesSearch(m.vessel);
}

function applyFilters() {
  // Per-dimension, per-category population counts (independent of other filters).
  const counts = {};
  for (const dim of DIM_KEYS) counts[dim] = {};
  let visible = 0;
  let moving = 0;
  for (const m of markers.values()) {
    for (const dim of DIM_KEYS) {
      const cat = categoryOf(m.vessel, dim);
      counts[dim][cat] = (counts[dim][cat] || 0) + 1;
    }
    const show = passes(m);
    if (show && !map.hasLayer(m)) m.addTo(map);
    else if (!show && map.hasLayer(m)) map.removeLayer(m);
    if (show) {
      visible++;
      if (statusBucket(m.vessel) === 'underway') moving++;
    }
  }
  // Fleet cell: present (unfiltered) composition + what's currently shown.
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  const t = counts.type, st = counts.status;
  set('fleet-total', markers.size);
  set('fleet-underway', st.underway || 0);
  set('fleet-anchored', st.anchored || 0);
  set('fleet-tankers', t.tanker || 0);
  set('fleet-cargo', t.cargo || 0);
  set('fleet-showing',
    visible === markers.size ? `Showing all · ${moving} under way`
      : `Showing ${visible} of ${markers.size} (filtered) · ${moving} under way`);

  document.querySelectorAll('#legend .chip').forEach((chip) => {
    const c = chip.querySelector('.cnt');
    if (c) c.textContent = counts[chip.dataset.dim][chip.dataset.cat] || 0;
  });
  if (allTracksOn) drawAllTracks(); // re-filter / re-colour overlay from cache
  if (heatmapOn) drawHeatmap();     // re-filter heatmap from cache (no refetch)
}

// --- Trails -----------------------------------------------------------------

async function showTrail(v) {
  selectedMmsi = v.mmsi;
  try {
    const res = await fetch(`/api/track?mmsi=${v.mmsi}&hours=${TRAIL_HOURS}`);
    const json = await res.json();
    trailPoints = json.points || [];
  } catch (_) {
    trailPoints = [];
  }
  drawTrail(v);
}

function drawTrail(v) {
  if (trailLayer) { map.removeLayer(trailLayer); trailLayer = null; }
  if (trailPoints.length < 2) return;
  const color = colorOf(v);
  const group = L.layerGroup();
  const n = trailPoints.length;
  for (let i = 1; i < n; i++) {
    const a = trailPoints[i - 1];
    const b = trailPoints[i];
    const opacity = 0.2 + 0.7 * (i / (n - 1)); // older segments fade out
    const seg = L.polyline(
      [[+a.lat, +a.lng], [+b.lat, +b.lng]],
      { color, weight: 3, opacity }
    );
    // Clicking the trail opens the same vessel card as the marker.
    seg.bindPopup(popupHtml(v));
    group.addLayer(seg);
  }
  group.addTo(map);
  trailLayer = group;
}

function clearTrail() {
  if (trailLayer) { map.removeLayer(trailLayer); trailLayer = null; }
  selectedMmsi = null;
  trailPoints = [];
}

// --- Identify chart features (OpenSeaMap symbols) ---------------------------

// seamark:type -> human label. Covers what's common in the Strait of Hormuz.
const SEAMARK_LABELS = {
  buoy_lateral: 'Lateral buoy (marks channel side)',
  beacon_lateral: 'Lateral beacon',
  buoy_cardinal: 'Cardinal buoy (danger marker)',
  beacon_cardinal: 'Cardinal beacon',
  buoy_safe_water: 'Safe-water buoy (mid-channel)',
  buoy_special_purpose: 'Special-purpose buoy',
  beacon_special_purpose: 'Special-purpose beacon',
  buoy_isolated_danger: 'Isolated-danger buoy',
  light_major: 'Major light / lighthouse',
  light_minor: 'Minor light',
  light_float: 'Light float',
  landmark: 'Landmark',
  separation_lane: 'Traffic separation lane',
  separation_boundary: 'Traffic separation boundary',
  separation_zone: 'Traffic separation zone (no-go)',
  separation_line: 'Traffic separation line',
  separation_crossing: 'Traffic crossing area',
  separation_roundabout: 'Traffic roundabout',
  inshore_traffic_zone: 'Inshore traffic zone',
  precautionary_area: 'Precautionary area',
  restricted_area: 'Restricted area',
  anchorage: 'Anchorage area',
  anchor_berth: 'Anchor berth',
  harbour: 'Harbour',
  harbour_basin: 'Harbour basin',
  mooring: 'Mooring',
  pile: 'Pile',
  pipeline_submarine: 'Submarine pipeline',
  cable_submarine: 'Submarine cable',
  platform: 'Offshore platform',
  production_area: 'Production area (oil/gas field)',
  wreck: 'Wreck',
  obstruction: 'Obstruction',
  rock: 'Rock',
  fairway: 'Fairway',
  navigation_line: 'Navigation line',
  recommended_track: 'Recommended track',
  radar_reflector: 'Radar reflector',
  fog_signal: 'Fog signal',
};

function describeSeamark(tags) {
  const type = tags['seamark:type'];
  const base = SEAMARK_LABELS[type] || (type ? type.replace(/_/g, ' ') : 'Seamark');
  const name = tags['seamark:name'] || tags.name || '';
  const extra = [];
  const colour =
    tags['seamark:buoy_lateral:colour'] || tags['seamark:beacon_lateral:colour'] ||
    tags['seamark:buoy_cardinal:colour'] || tags['seamark:light:colour'];
  if (colour) extra.push(colour);
  const category =
    tags['seamark:buoy_lateral:category'] || tags['seamark:buoy_cardinal:category'] ||
    tags['seamark:restricted_area:category'];
  if (category) extra.push(category.replace(/_/g, ' '));
  const character = tags['seamark:light:character'];
  if (character) extra.push('light ' + character);
  return { base, name, extra: extra.join(', ') };
}

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

async function identifyAt(latlng) {
  const r = 600; // metres — catches nearby marks and lane/zone boundaries
  const c = `${latlng.lat},${latlng.lng}`;
  // Include relations so TSS lanes/zones (often relations) are identified too.
  const q =
    `[out:json][timeout:15];(` +
    `node(around:${r},${c})["seamark:type"];` +
    `way(around:${r},${c})["seamark:type"];` +
    `relation(around:${r},${c})["seamark:type"];` +
    `);out center tags 40;`;
  const data = 'data=' + encodeURIComponent(q);

  let lastErr;
  for (const ep of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(ep, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: data,
      });
      if (!res.ok) throw new Error(`overpass ${res.status}`);
      const json = await res.json(); // throws if the mirror returned an HTML error
      return json.elements || [];
    } catch (e) {
      lastErr = e; // try the next mirror
    }
  }
  throw lastErr || new Error('overpass unavailable');
}

function identifyHtml(elements) {
  if (!elements.length) {
    return '<div class="ident">No charted features right here — try clicking closer to a symbol.</div>';
  }
  const seen = new Set();
  const rows = [];
  for (const el of elements) {
    const d = describeSeamark(el.tags || {});
    const key = d.base + '|' + d.name;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(
      `<div class="ident-row"><b>${esc(d.base)}</b>` +
      `${d.name ? ` — ${esc(d.name)}` : ''}` +
      `${d.extra ? `<br><span class="muted">${esc(d.extra)}</span>` : ''}</div>`
    );
    if (rows.length >= 8) break;
  }
  return `<div class="ident"><div class="ident-h">Chart features here</div>${rows.join('')}</div>`;
}

async function onMapClick(e) {
  if (trailLayer) { clearTrail(); return; } // dismiss a trail first
  const popup = L.popup({ maxWidth: 280 })
    .setLatLng(e.latlng)
    .setContent('Identifying chart features…')
    .openOn(map);
  try {
    popup.setContent(identifyHtml(await identifyAt(e.latlng)));
  } catch (_) {
    popup.setContent('<div class="ident">Could not reach OpenSeaMap data (Overpass). Try again.</div>');
  }
}

function zoomToVisible() {
  const pts = [];
  for (const m of markers.values()) if (passes(m)) pts.push(m.getLatLng());
  if (pts.length === 1) map.setView(pts[0], 12);
  else if (pts.length > 1) map.fitBounds(L.latLngBounds(pts).pad(0.2));
}

window.__refresh = refresh;
init();
