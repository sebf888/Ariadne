'use strict';

/**
 * Sanctions / designated-vessel watchlist — operator-maintained reference data
 * cross-matched against live AIS. Pure (no DB), so selftest.js can cover it.
 *
 * The list lives in data/sanctions.json so the desk can edit it without code
 * changes; the loader re-reads on demand (cheap; the file is small) so edits
 * take effect without a restart. A match is an *exposure signal*, not proof —
 * IMO/MMSI can themselves be spoofed, which the integrity layer flags separately.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_PATH = path.join(__dirname, '..', 'data', 'sanctions.json');

// Normalise one raw entry. IMO/MMSI are kept as trimmed strings (the keys we
// match on) so '9249882' and 9249882 collapse together. Underscore-prefixed
// keys in the JSON (schema/example docs) are skipped by the caller.
function normalizeEntry(e) {
  const str = (x) => (x != null && String(x).trim() !== '' ? String(x).trim() : null);
  return {
    imo: str(e.imo),
    mmsi: str(e.mmsi),
    name: e.name || null,
    program: e.program || null,
    listed: e.listed || null,
    source: e.source || null,
    note: e.note || null,
  };
}

// Read + normalise the watchlist. Accepts either a bare array or a
// { entries: [...] } envelope. Missing/invalid file ⇒ empty list (the cell then
// renders a "not populated" state rather than erroring). Entries without any
// usable key (no imo and no mmsi) are dropped — they can never match.
function loadWatchlist(file = DEFAULT_PATH) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return [];
  }
  const list = Array.isArray(raw) ? raw : Array.isArray(raw.entries) ? raw.entries : [];
  return list.map(normalizeEntry).filter((e) => e.imo || e.mmsi);
}

// Build IMO/MMSI lookup maps from normalised entries.
function indexWatchlist(entries) {
  const byImo = new Map();
  const byMmsi = new Map();
  for (const e of entries) {
    if (e.imo) byImo.set(e.imo, e);
    if (e.mmsi) byMmsi.set(e.mmsi, e);
  }
  return { byImo, byMmsi, size: entries.length };
}

// Match one live vessel against the index. IMO is the durable hull identity
// (it survives reflagging and MMSI changes), so it's tried first; MMSI is the
// fallback. Returns { entry, on: 'imo'|'mmsi' } or null.
function matchVessel(v, index) {
  if (v.imo != null && index.byImo.has(String(v.imo))) {
    return { entry: index.byImo.get(String(v.imo)), on: 'imo' };
  }
  if (v.mmsi != null && index.byMmsi.has(String(v.mmsi))) {
    return { entry: index.byMmsi.get(String(v.mmsi)), on: 'mmsi' };
  }
  return null;
}

module.exports = { DEFAULT_PATH, normalizeEntry, loadWatchlist, indexWatchlist, matchVessel };
