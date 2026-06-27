'use strict';

/**
 * Integrity layer — pure, DB-free logic for the Phase 4 signals.
 *
 * These functions back the identity / spoofing flags and the geometry helpers
 * the dark-ship and impossible-jump detectors rely on. Kept pure so selftest.js
 * can cover them with no DB or API. The cross-cycle, stateful signals
 * (materialised dark_events / sts_candidates) live in lib/db.js.
 */

const EARTH_NM = 3440.065; // Earth radius in nautical miles

const toRad = (d) => (d * Math.PI) / 180;

// Great-circle distance between two {lat,lng} points, in nautical miles.
function haversineNm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Implied speed (knots) needed to get from fix `a` to fix `b`, given their
 * timestamps. Returns null when the time delta is non-positive or unusable —
 * a zero/negative interval can't imply a speed and must not divide.
 */
function impliedSpeedKn(a, b) {
  const t0 = new Date(a.ts).getTime();
  const t1 = new Date(b.ts).getTime();
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return null;
  const hours = (t1 - t0) / 3.6e6;
  if (hours <= 0) return null;
  return haversineNm(a, b) / hours;
}

/**
 * A jump between two consecutive fixes is "impossible" when it covers real
 * distance (not AIS jitter) *and* implies a speed no vessel could hold — the
 * classic signature of position spoofing or a swapped identity. Both gates must
 * trip so a normal fast tanker over a long gap isn't flagged.
 */
function isImpossibleJump(a, b, cfg) {
  const spd = impliedSpeedKn(a, b);
  if (spd === null) return false;
  const km = haversineNm(a, b) * 1.852;
  return km >= cfg.jumpMinDistKm && spd > cfg.jumpMaxSpeedKn;
}

/**
 * IMO number check-digit validation. A valid IMO is 7 digits where the last is
 * (Σ digit_i × weight_i) mod 10 over the first six, weights 7..2. Invalid or
 * mismatched check digits are a common shadow-fleet / spoofing tell.
 */
function imoChecksumValid(imo) {
  if (imo === null || imo === undefined) return false;
  const s = String(imo).trim();
  if (!/^\d{7}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 6; i++) sum += Number(s[i]) * (7 - i);
  return sum % 10 === Number(s[6]);
}

/**
 * Plausible ship-station MMSI: nine digits whose MID (first three) sits in the
 * 201–775 range assigned to ship stations. Coast stations (0xx), SAR aircraft
 * (111xxxxxx), handhelds (8xx) and AtoN/craft (98x, 99x, 970–974) all fall
 * outside that and read as odd for a vessel under way.
 */
function mmsiPlausible(mmsi) {
  if (mmsi === null || mmsi === undefined) return false;
  const s = String(mmsi).trim();
  if (!/^\d{9}$/.test(s)) return false;
  const mid = Number(s.slice(0, 3));
  return mid >= 201 && mid <= 775;
}

/**
 * Static identity flags for one vessel row. Returns a (possibly empty) array of
 * short codes. `length` is the AIS-derived hull length (a+b); used to decide
 * whether a missing IMO is noteworthy (SOLAS requires an IMO number for large
 * cargo/tanker tonnage, so its absence on a sizeable tanker is a real signal).
 */
function identityFlags(v, cfg) {
  const flags = [];
  const isTanker = /tanker/i.test(v.type || '');
  const big = (v.length || 0) >= (cfg.identityMinLengthM || 100);

  if (v.imo === null || v.imo === undefined || Number(v.imo) === 0) {
    if (isTanker && big) flags.push('no-imo');
  } else if (!imoChecksumValid(v.imo)) {
    flags.push('bad-imo');
  }
  if (!mmsiPlausible(v.mmsi)) flags.push('odd-mmsi');
  return flags;
}

/**
 * Composite shadow-fleet risk weights, one per behavioural/identity tell the
 * integrity layer already detects. Ordered loosely strongest→weakest. A
 * sanctions-watchlist match dominates by construction; IMO swaps are near-
 * definitive identity fraud (a hull's IMO is permanent); the rest are softer
 * shadow-fleet correlates. All tunable — these are an analyst prior, not truth.
 */
const RISK_WEIGHTS = {
  watchlist: 0.97, // matched a designated-vessel list (sanctions exposure)
  imoSwap:   0.55, // broadcast a changed IMO number
  reflag:    0.30, // flag-hopping
  badImo:    0.30, // invalid IMO checksum
  dark:      0.30, // went dark in the interior while under way
  jump:      0.25, // impossible position jump
  sts:       0.20, // sustained ship-to-ship alongside
  noImo:     0.15, // large tanker broadcasting no IMO
  oddMmsi:   0.15, // implausible MMSI for a ship station
};

// Short display labels for each tell (for the dashboard reason list).
const RISK_LABELS = {
  watchlist: 'sanctioned', imoSwap: 'IMO swap', reflag: 'reflag',
  badImo: 'bad-IMO', dark: 'dark', jump: 'jump', sts: 'STS',
  noImo: 'no-IMO', oddMmsi: 'odd-MMSI',
};

/**
 * Fuse the fired tells for one vessel into a single risk score in [0,1].
 * Combined by *noisy-OR* (score = 1 − Π(1 − wᵢ) over fired tells): independent
 * weak signals accumulate but saturate, so no single heuristic reads as proof
 * and a pile of soft tells still climbs. `tells` is an object of tell→truthy.
 */
function shadowFleetScore(tells) {
  let inv = 1;
  for (const k of Object.keys(RISK_WEIGHTS)) {
    if (tells && tells[k]) inv *= 1 - RISK_WEIGHTS[k];
  }
  return Math.round((1 - inv) * 100) / 100;
}

// Fired tells as ordered short labels (strongest weight first) for display.
function riskReasons(tells) {
  return Object.keys(RISK_WEIGHTS)
    .filter((k) => tells && tells[k])
    .map((k) => RISK_LABELS[k]);
}

// True when a point sits inside the bbox by at least `edge` degrees on every
// side — i.e. far enough from the boundary that a vanished vessel can't be
// explained by it simply sailing out of the watched area.
function inInterior(lat, lng, bbox, edge) {
  return (
    lat >= bbox.lat_min + edge &&
    lat <= bbox.lat_max - edge &&
    lng >= bbox.long_min + edge &&
    lng <= bbox.long_max - edge
  );
}

module.exports = {
  haversineNm,
  impliedSpeedKn,
  isImpossibleJump,
  imoChecksumValid,
  mmsiPlausible,
  identityFlags,
  inInterior,
  RISK_WEIGHTS,
  RISK_LABELS,
  shadowFleetScore,
  riskReasons,
};
