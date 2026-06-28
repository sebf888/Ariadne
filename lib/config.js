'use strict';

/** Shared configuration. */

// AOI is now tiled (see TILES below) — the whole Gulf exceeds the 2000/call
// cap, so we fetch a grid of strips. BBOX is derived as the union of the tiles
// and used for AOI-wide tests (dark-ship interior) and the map's initial frame.
// Defined after TILES.
const unionBounds = (tiles) => ({
  lat_min: Math.min(...tiles.map((t) => t.lat_min)),
  lat_max: Math.max(...tiles.map((t) => t.lat_max)),
  long_min: Math.min(...tiles.map((t) => t.long_min)),
  long_max: Math.max(...tiles.map((t) => t.long_max)),
});

// Two-gate cordon across the strait. Each gate is a line (endpoints [lat,lng]),
// perpendicular to the NW–SE traffic flow, offset along the axis: W on the
// Persian Gulf side, E on the Gulf of Oman side. A *completed passage* crosses
// both gates in order — robust to loitering / U-turns (which never hit both).
//
// These are the extended cordon line (lat 25.97–26.93) shifted ±0.28° lng.
// NOTE: approximate defaults — view them on the map against the TSS lanes and
// adjust so each gate cleanly spans the navigable channel.
const GATES = {
W: { 
  a: { lat: 25.97, lng: 56.05 }, 
  b: { lat: 27.09, lng: 56.03 } 
},
E: {
  a: { lat: 25.83, lng: 56.36 },
  b: { lat: 27.17, lng: 56.49 }
},};

// Proposed whole-Gulf tiling (Phase: scale-out) — "vertical strips" model: a
// deep Hormuz->Abu Dhabi column (lng 54.5-57.6), then longitude strips marching
// west, each spanning the water N-S. Each tile is one /vessel/area call and must
// stay under the 2000-vessel cap with headroom. Counts are live measurements
// (2026-06-24). Two dense zones can't be full-height strips: the Hormuz column
// is cut at lat 25.5 (strait vs Dubai coast), and the Qatar/Bahrain/Saudi strip
// is cut into three (E/W + a sparse north). `priority` tiles poll every cycle
// (the cordon lives in `hormuz`); the rest round-robin (see ingest.js fetchAoi).
const TILES = [
  // Strip 1 — Hormuz column (lng 54.5-57.6), cut at lat 25.5:
  { name: 'hormuz',          priority: true, lat_min: 25.5, lat_max: 27.2, long_min: 54.5, long_max: 57.6 }, //  601
  { name: 'uae-coast',       lat_min: 24.3, lat_max: 25.5, long_min: 54.5, long_max: 57.6 },                 // 1451
  // Strip 2 (lng 52.0-54.5), full water column:
  { name: 'central',         lat_min: 24.3, lat_max: 27.8, long_min: 52.0, long_max: 54.5 },                 //  986
  // Strip 3 (lng 49.5-52.0) — dense; cut E/W + sparse north:
  { name: 'dammam-bahrain',  lat_min: 24.8, lat_max: 27.2, long_min: 49.5, long_max: 50.9 },                 // ~900 (split of 1828)
  { name: 'qatar-raslaffan', lat_min: 24.8, lat_max: 27.2, long_min: 50.9, long_max: 52.0 },                 // ~900 (split of 1828)
  { name: 'jubail-bushehr',  lat_min: 27.2, lat_max: 29.8, long_min: 49.5, long_max: 52.0 },                 //  461
  // Strip 4 (lng 47.8-49.5) — Kuwait / Shatt al-Arab:
  { name: 'nw-kuwait',       lat_min: 28.3, lat_max: 30.5, long_min: 47.8, long_max: 49.5 },                 //  975
];

// Whole-AOI bounding box = union of all tiles (Gulf-wide). Used by dark-ship
// interior detection and the map frame; ingestion fetches per-tile, not this.
const BBOX = unionBounds(TILES);

module.exports = {
  BBOX,
  TILES,
  GATES,
  // Max time between gates to still count as one passage (rejects unrelated
  // pairings; loiterers that eventually complete get a 'slow' flag).
  MAX_TRANSIT_HOURS: Number(process.env.MAX_TRANSIT_HOURS || 12),
  // A completed passage slower than this (minutes) is flagged 'slow'.
  SLOW_TRANSIT_MIN: Number(process.env.SLOW_TRANSIT_MIN || 360),
  // Rolling window reprocessed each cycle to catch new crossings (idempotent).
  CROSSINGS_LOOKBACK_HOURS: Number(process.env.CROSSINGS_LOOKBACK_HOURS || 26),

  // Barrel-flow estimation factors (Phase 3). Marinesia gives no DWT, so we
  // estimate capacity from AIS length and laden state from draught. These are
  // transparent, tunable assumptions — treat outputs as estimates.
  FLOW: {
    refLen: 330,           // reference tanker length (m) ...
    refDwt: 300000,        // ... at this deadweight (VLCC) — DWT ≈ refDwt*(L/refLen)^3
    cargoFraction: 0.93,   // cargo as fraction of DWT
    bblPerTonne: 7.33,     // barrels per tonne of crude
    draughtCoef: 0.066,    // design draught ≈ draughtCoef * length
    ballastFraction: 0.5,  // ballast draught ≈ this * design draught
    fallbackLadenOut: 0.95, // assumed load if no draught: outbound (laden export)
    fallbackLadenIn: 0.10,  // ... inbound (ballast return)
    minLengthM: 100,        // ignore tankers shorter than this for capacity est.
  },
  // Integrity layer (Phase 4). Thresholds for the absence/proximity/identity
  // signals. All tunable; defaults chosen for the Strait's traffic profile.
  INTEGRITY: {
    // Dark ships — vanished while plausibly still inside and under way.
    darkMinHours: Number(process.env.DARK_MIN_HOURS || 1),   // quiet at least this long
    darkMaxHours: Number(process.env.DARK_MAX_HOURS || 24),  // older ⇒ treat as departed, not dark
    darkEdgeDeg: 0.05,    // last fix must be ≥ this far inside the bbox (interior, not exiting)
    darkMinSog: 1,        // was making way (kn); a vessel at anchor going quiet is routine
    darkExitGraceHours: 3, // if it crossed a cordon gate this recently, it transited out (not dark)
    darkJumpKm: 20,       // re-appeared this far from where it vanished ⇒ flag 'jumped'
    // Ship-to-ship transfer candidates.
    stsMaxDistM: 500,     // alongside if within this many metres
    stsMaxSog: 0.7,       // both effectively stopped (kn)
    stsMinDurMin: 60,     // surface only episodes sustained at least this long
    stsGapMin: 30,        // re-link to an open episode if seen again within this many minutes
    // Identity / spoofing.
    jumpMaxSpeedKn: 60,   // implied speed above this between fixes ⇒ impossible jump
    jumpMinDistKm: 5,     // ignore sub-jitter; only flag genuine teleports
    identityMinLengthM: 100, // a missing IMO matters on hulls at least this long
  },

  // Floating storage / anchorage queue. A tanker is "parked" when its track
  // over the window never strayed far (bbox diagonal) and it was effectively
  // stopped on average — laden+parked for long enough reads as floating storage.
  STORAGE: {
    minHours: Number(process.env.STORAGE_MIN_HOURS || 6),   // parked at least this long in-window
    maxSpanKm: Number(process.env.STORAGE_MAX_SPAN_KM || 5), // track bbox diagonal stayed under this
    maxAvgSog: Number(process.env.STORAGE_MAX_AVG_SOG || 0.7), // effectively stopped on average (kn)
    clusterKm: Number(process.env.STORAGE_CLUSTER_KM || 12), // parked tankers within this ⇒ same queue
  },

  // Known waiting / anchorage areas, excluded from STS candidates: vessels
  // clustering there is routine, not a clandestine transfer. {lat, lng, radiusKm}.
  // Empty by default — the tanker-involvement filter already removes most
  // anchorage noise; enable specific zones per operator judgement. Dense
  // clusters observed in current data near 26.6,54.9 (W Gulf) and 26.0,56.1
  // (strait approach) are candidates once confirmed as designated anchorages.
  ANCHORAGES: [],

  PORT: Number(process.env.PORT || 3000),
  INGEST_INTERVAL_MS: Number(process.env.INGEST_INTERVAL_MS || 60000),
  // A vessel shows on the map if seen in the feed within this many minutes
  // (presence, by ingestion time — not the age of its last AIS transmission).
  LIVE_WINDOW_MIN: Number(process.env.LIVE_WINDOW_MIN || 15),
  POSITIONS_RETENTION_DAYS: Number(process.env.POSITIONS_RETENTION_DAYS || 30),
};
