'use strict';

/**
 * Vessel size / cargo estimation — the single, documented source of truth for
 * every barrel number Ariadne reports. Pure functions (no DB), unit-tested in
 * selftest.js. The SQL rollups (lib/db.js) mirror these exact formulas and
 * constants (from config.FLOW); this module is the reference and the place to
 * change the maths.
 *
 * WHY ESTIMATES: the AIS area feed carries no deadweight (DWT) or cargo figure,
 * only hull dimensions (length, beam) and a self-reported draught. So capacity
 * is inferred from length and load state from draught. Every output is
 * therefore an ESTIMATE and is labelled as such. See METHODOLOGY.md.
 */

// Canonical tanker size classes by overall length (m). Bands are indicative —
// length↔class is fuzzy at the edges — and used for labelling/breakdowns only,
// never for the barrel maths (which is continuous, below). Ranges follow the
// conventional crude/product tanker ladder.
const CLASSES = [
  { name: 'ULCC',        min: 340, max: Infinity },
  { name: 'VLCC',        min: 300, max: 340 },
  { name: 'Suezmax',     min: 264, max: 300 },
  { name: 'Aframax/LR2', min: 228, max: 264 },
  { name: 'Panamax/LR1', min: 200, max: 228 },
  { name: 'MR',          min: 165, max: 200 },
  { name: 'Handy',       min: 100, max: 165 },
];

function vesselClass(lengthM) {
  if (lengthM == null || !(lengthM > 0)) return null;
  for (const c of CLASSES) if (lengthM >= c.min && lengthM < c.max) return c.name;
  return null;
}

// Cargo-grade PROXY from size. This feed declares no cargo grade — every
// liquid-bulk hull is just "Tanker" — so grade is inferred from length, the
// standard dirty/clean heuristic: Aframax and larger (≥ CRUDE_MIN_LEN) move
// crude and dirty products; below that (LR1/MR/Handy) move clean products. It
// is a PROXY, not a declared classification (LR2 ≈ Aframax-size clean carriers
// are the known ambiguous case), and gas carriers (LNG/LPG) can't be separated
// at all. Always label outputs as size-proxy. See METHODOLOGY.md §cargo.
const CRUDE_MIN_LEN = 228; // m — Aframax floor; dirty/clean divide

function cargoProxy(lengthM) {
  if (lengthM == null || !(lengthM >= 100)) return null;
  return lengthM >= CRUDE_MIN_LEN ? 'crude' : 'product';
}

// Plausible deadweight envelope for a merchant tanker (tonnes). Clamps guard the
// cube law against absurd/mislabelled hulls (e.g. a 380 m box ship tagged
// "tanker") inflating a barrel total. Seawise Giant (564k DWT) is the historical
// ULCC ceiling; we allow a little headroom.
const DWT_MIN = 3000;
const DWT_MAX = 650000;

/**
 * Estimated deadweight (tonnes) from length via a cube law anchored on a
 * reference VLCC: DWT ≈ refDwt · (L / refLen)³. Deadweight scales with displaced
 * volume (~L³ for geometrically similar hulls); anchoring on a known class keeps
 * the VLCC band exact and holds within ~±20% across the ladder (validated
 * against the live class distribution). Returns null below the min length
 * (small hulls we don't price), and clamps to the plausible envelope.
 */
function estimateDwt(lengthM, f) {
  if (lengthM == null || lengthM < f.minLengthM) return null;
  const dwt = f.refDwt * Math.pow(lengthM / f.refLen, 3);
  return Math.round(Math.min(DWT_MAX, Math.max(DWT_MIN, dwt)));
}

/**
 * Estimated laden cargo capacity in barrels: DWT · cargoFraction · bblPerTonne.
 * cargoFraction (~0.93) is cargo as a share of deadweight (rest is bunkers,
 * stores, ballast); bblPerTonne (7.33) is the standard barrels-per-tonne for a
 * typical crude (~33.4° API). Returns null when DWT is unknown.
 */
function capacityBbl(lengthM, f) {
  const dwt = estimateDwt(lengthM, f);
  if (dwt == null) return null;
  return Math.round(dwt * f.cargoFraction * f.bblPerTonne);
}

/**
 * Laden fraction in [0,1] from reported draught vs estimated design draught.
 * Linear between an assumed ballast draught (ballastFraction · design) and full
 * design draught: 0 = ballast (empty), 1 = fully laden. Returns null when draught
 * or a positive design draught is missing (caller falls back to a direction
 * assumption, and must disclose it). Self-reported draught is a known-noisy AIS
 * field — crews often leave it static — hence load state is an estimate.
 */
function ladenFraction(draught, designDraught, ballastFraction) {
  if (draught == null || !(designDraught > 0)) return null;
  const frac = (draught - ballastFraction * designDraught)
             / ((1 - ballastFraction) * designDraught);
  return Math.min(1, Math.max(0, frac));
}

// Design draught (m) from length — the depth a hull sits at when fully laden.
function designDraught(lengthM, f) {
  if (lengthM == null || !(lengthM > 0)) return null;
  return f.draughtCoef * lengthM;
}

// Implied laden barrels on board = capacity · laden fraction (null if either
// input is unknown, so unknowns never silently count as zero).
function impliedBarrels(capacityBblValue, ladenFracValue) {
  if (capacityBblValue == null || ladenFracValue == null) return null;
  return Math.round(capacityBblValue * ladenFracValue);
}

module.exports = {
  CLASSES,
  DWT_MIN,
  DWT_MAX,
  CRUDE_MIN_LEN,
  vesselClass,
  cargoProxy,
  estimateDwt,
  capacityBbl,
  designDraught,
  ladenFraction,
  impliedBarrels,
};
