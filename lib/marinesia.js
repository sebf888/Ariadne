'use strict';

/** Marinesia API client + payload normalization. */

const https = require('https');

const API_BASE = process.env.MARINESIA_BASE || 'https://api.marinesia.com';

// Global rolling rate limiter: never more than MAX_PER_MIN calls in any 60s
// window, across area + history calls. Tiled ingestion issues several calls per
// cycle; this guarantees we stay within Marinesia's 5/min budget regardless of
// how the cycle bursts (a call that would exceed the window simply waits).
const MAX_PER_MIN = Number(process.env.MARINESIA_MAX_PER_MIN || 5);
const callTimes = []; // epoch ms of recent calls (oldest first)

async function rateLimit() {
  for (;;) {
    const now = Date.now();
    while (callTimes.length && now - callTimes[0] >= 60000) callTimes.shift();
    if (callTimes.length < MAX_PER_MIN) {
      callTimes.push(now);
      return;
    }
    const waitMs = 60000 - (now - callTimes[0]) + 5; // until the oldest leaves the window
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

async function getJson(pathWithQuery) {
  await rateLimit();
  return new Promise((resolve, reject) => {
    https
      .get(`${API_BASE}${pathWithQuery}`, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(
              new Error(`Marinesia ${res.statusCode}: ${data.slice(0, 300)}`)
            );
          }
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Marinesia: invalid JSON (${e.message})`));
          }
        });
      })
      .on('error', reject);
  });
}

// The API may wrap the array in an envelope; pull the array out regardless.
function extractVessels(json) {
  if (Array.isArray(json)) return json;
  if (json && typeof json === 'object') {
    for (const key of ['data', 'vessels', 'results', 'items']) {
      if (Array.isArray(json[key])) return json[key];
    }
  }
  return [];
}

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const int = (v) => {
  const n = num(v);
  return n === null ? null : Math.trunc(n);
};

const plausible = (d) => {
  if (Number.isNaN(d.getTime())) return false;
  const y = d.getUTCFullYear();
  return y >= 2015 && y <= 2100;
};

/**
 * Parse a feed timestamp robustly. AIS feeds vary: ISO strings, epoch
 * seconds/ms, or timezone-naive datetimes. We normalize all of them to a Date,
 * assuming UTC when no zone is given, and fall back when the result is absurd.
 */
function parseTs(rawTs, fallback) {
  if (rawTs === null || rawTs === undefined || rawTs === '') return fallback;

  // Numeric (or all-digit string) => epoch seconds or milliseconds.
  if (typeof rawTs === 'number' || /^\d+$/.test(String(rawTs).trim())) {
    const n = Number(rawTs);
    const d = new Date(n < 1e12 ? n * 1000 : n); // <1e12 ⇒ seconds
    return plausible(d) ? d : fallback;
  }

  let s = String(rawTs).trim();
  // No timezone marker on a datetime ⇒ assume UTC (avoid local-time skew).
  const hasTz = /([zZ]|[+-]\d{2}:?\d{2})$/.test(s);
  if (!hasTz && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s)) {
    s = s.replace(' ', 'T') + 'Z';
  }
  const d = new Date(s);
  return plausible(d) ? d : fallback;
}

/**
 * Turn a raw area-feed vessel into our { vessel, position } split, or null if
 * it lacks the minimum needed (mmsi + coordinates).
 */
function normalizeVessel(raw, fallbackTs = new Date()) {
  if (!raw) return null;
  const mmsi = int(raw.mmsi);
  const lat = num(raw.lat);
  const lng = num(raw.lng);
  if (mmsi === null || lat === null || lng === null) return null;

  const tsIso = parseTs(raw.ts, fallbackTs).toISOString();

  return {
    vessel: {
      mmsi,
      imo: int(raw.imo),
      name: raw.name || null,
      type: raw.type || null,
      flag: raw.flag || null,
      a: int(raw.a),
      b: int(raw.b),
      c: int(raw.c),
      d: int(raw.d),
      last_seen: tsIso,
    },
    position: {
      mmsi,
      ts: tsIso,
      lat,
      lng,
      sog: num(raw.sog),
      cog: num(raw.cog),
      hdt: int(raw.hdt),
      rot: num(raw.rot),
      draught: num(raw.draught), // absent from area feed; present on backfill
      status: int(raw.status),
      dest: raw.dest || null,
      eta: raw.eta || null,
    },
  };
}

/**
 * Normalize + dedupe a raw area feed into { vessels, positions } ready to
 * write. The feed can repeat an MMSI within one snapshot, which would make
 * `INSERT … ON CONFLICT DO UPDATE` touch the same row twice (a Postgres error),
 * so we collapse vessels to one row per MMSI (keeping the latest last_seen) and
 * positions to one row per (mmsi, ts).
 */
function buildSnapshot(rawList, fallbackTs = new Date()) {
  // "Present now" is when WE observed the vessel in the feed (ingestion time),
  // not when it last transmitted (position.ts, which can be hours old).
  const ingestIso = fallbackTs.toISOString();
  const vesselsByMmsi = new Map();
  const positionsByKey = new Map();
  for (const r of rawList) {
    const n = normalizeVessel(r, fallbackTs);
    if (!n) continue;
    n.vessel.last_seen = ingestIso;
    // Denormalize this report's position onto the vessel row so the live map
    // can read it without touching the positions fact table (see lib/db.js
    // buildVesselUpsert / getLiveVessels). p is the AIS transmit position;
    // p.ts (cur_ts) can lag last_seen, which is ingestion time.
    const p = n.position;
    Object.assign(n.vessel, {
      cur_lat: p.lat, cur_lng: p.lng, cur_sog: p.sog, cur_cog: p.cog,
      cur_hdt: p.hdt, cur_rot: p.rot, cur_draught: p.draught,
      cur_status: p.status, cur_dest: p.dest, cur_eta: p.eta, cur_ts: p.ts,
    });
    // Keep the newest position when an MMSI repeats within a snapshot (feed
    // rows can arrive out of order); ISO-8601 strings sort chronologically.
    const prev = vesselsByMmsi.get(n.vessel.mmsi);
    if (!prev || (p.ts && (!prev.cur_ts || p.ts >= prev.cur_ts))) {
      vesselsByMmsi.set(n.vessel.mmsi, n.vessel);
    }
    positionsByKey.set(`${n.position.mmsi}|${n.position.ts}`, n.position);
  }
  return {
    vessels: [...vesselsByMmsi.values()],
    positions: [...positionsByKey.values()],
  };
}

/**
 * Normalize a historical-location feed for one vessel into position rows,
 * deduped by ts. The history endpoint is queried by MMSI, so records may omit
 * it — we force it on.
 */
function buildTrack(rawList, mmsi, fallbackTs = new Date()) {
  const byTs = new Map();
  for (const r of rawList) {
    const rec = r && r.mmsi != null ? r : { ...r, mmsi };
    const n = normalizeVessel(rec, fallbackTs);
    if (n) byTs.set(n.position.ts, n.position);
  }
  return [...byTs.values()];
}

async function fetchArea(bbox, key) {
  const qs = new URLSearchParams({
    lat_min: bbox.lat_min,
    lat_max: bbox.lat_max,
    long_min: bbox.long_min,
    long_max: bbox.long_max,
    key,
  });
  const json = await getJson(`/api/v2/vessel/area?${qs}`);
  return extractVessels(json);
}

// For Phase 1 lazy backfill (historical track for a single vessel).
async function fetchHistory({ mmsi, imo }, key) {
  const qs = new URLSearchParams({ key });
  if (mmsi) qs.set('mmsi', mmsi);
  if (imo) qs.set('imo', imo);
  const json = await getJson(`/api/v2/vessel/location?${qs}`);
  return extractVessels(json);
}

module.exports = { fetchArea, fetchHistory, extractVessels, normalizeVessel, buildSnapshot, buildTrack, parseTs };
