'use strict';

/** Postgres access layer. Pure SQL builders are exported for testing. */

const { Pool } = require('pg');
const integrity = require('./integrity');
const sanctions = require('./sanctions');

let pool;
function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is not set');
    }
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // Managed Postgres (Supabase/Neon) requires TLS; they use certs that
      // don't always validate against the system store, hence rejectUnauthorized.
      ssl: process.env.PGSSL_DISABLE ? false : { rejectUnauthorized: false },
      max: Number(process.env.PG_POOL_MAX || 5),
    });
  }
  return pool;
}

function query(text, values) {
  return getPool().query(text, values);
}

// --- Pure builders (no DB needed; unit-tested in selftest.js) ---------------

// Bulk upsert of vessels via UNNEST. Returns { text, values }.
function buildVesselUpsert(vessels) {
  const cols = ['mmsi', 'imo', 'name', 'type', 'flag', 'a', 'b', 'c', 'd', 'last_seen'];
  const values = cols.map((c) => vessels.map((v) => v[c]));
  const text = `
    INSERT INTO vessels (mmsi, imo, name, type, flag, a, b, c, d, last_seen)
    SELECT u.mmsi, u.imo, u.name, u.type, u.flag, u.a, u.b, u.c, u.d, u.last_seen
    FROM unnest(
      $1::bigint[], $2::bigint[], $3::text[], $4::text[], $5::text[],
      $6::int[], $7::int[], $8::int[], $9::int[], $10::timestamptz[]
    ) AS u(mmsi, imo, name, type, flag, a, b, c, d, last_seen)
    ON CONFLICT (mmsi) DO UPDATE SET
      imo  = COALESCE(EXCLUDED.imo,  vessels.imo),
      name = COALESCE(EXCLUDED.name, vessels.name),
      type = COALESCE(EXCLUDED.type, vessels.type),
      flag = COALESCE(EXCLUDED.flag, vessels.flag),
      a = COALESCE(EXCLUDED.a, vessels.a),
      b = COALESCE(EXCLUDED.b, vessels.b),
      c = COALESCE(EXCLUDED.c, vessels.c),
      d = COALESCE(EXCLUDED.d, vessels.d),
      last_seen = GREATEST(vessels.last_seen, EXCLUDED.last_seen);`;
  return { text, values };
}

// Bulk insert of positions via UNNEST, idempotent on (mmsi, ts).
function buildPositionInsert(positions) {
  const cols = ['mmsi', 'ts', 'lat', 'lng', 'sog', 'cog', 'hdt', 'rot', 'draught', 'status', 'dest', 'eta'];
  const values = cols.map((c) => positions.map((p) => p[c]));
  const text = `
    INSERT INTO positions (mmsi, ts, lat, lng, sog, cog, hdt, rot, draught, status, dest, eta)
    SELECT * FROM unnest(
      $1::bigint[], $2::timestamptz[], $3::float8[], $4::float8[],
      $5::float8[], $6::float8[], $7::int[], $8::float8[],
      $9::float8[], $10::int[], $11::text[], $12::text[]
    )
    ON CONFLICT (mmsi, ts) DO NOTHING;`;
  return { text, values };
}

// --- Executing helpers ------------------------------------------------------

async function saveSnapshot(vessels, positions) {
  if (!vessels.length) return { inserted: 0 };
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const vu = buildVesselUpsert(vessels);
    await client.query(vu.text, vu.values);
    const pi = buildPositionInsert(positions);
    const res = await client.query(pi.text, pi.values);
    await client.query('COMMIT');
    return { inserted: res.rowCount };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Vessels currently present in the area (seen in the feed within the window),
// each with its latest known position. Presence is driven by v.last_seen
// (ingestion time); the position itself may be an older AIS report (p.ts).
//
// PERF: the unbounded `DISTINCT ON` merge-joined the entire positions table
// (>1M rows) on every call, which timed out once Gulf-wide tiling grew the
// data. We bound the position scan to a recent window so the planner rides
// positions_ts_idx instead of scanning all history. This drops contacts whose
// latest AIS report is older than the bound; the denormalized vessels.pos_*
// columns (see getLiveVesselsFast) are the permanent fix that restores them.
const LIVE_POS_BUFFER_MIN = 15; // extra slack beyond the presence window
async function getLiveVessels(windowMinutes) {
  const { rows } = await query(
    `SELECT DISTINCT ON (p.mmsi)
        p.mmsi, v.imo, v.name, v.type, v.flag, v.length,
        p.lat, p.lng, p.cog, p.sog, p.hdt, p.rot, p.draught,
        p.status, p.dest, p.eta, p.ts
     FROM vessels v
     JOIN positions p ON p.mmsi = v.mmsi
     WHERE v.last_seen > now() - make_interval(mins => $1::int)
       AND p.ts       > now() - make_interval(mins => $1::int + $2::int)
     ORDER BY p.mmsi, p.ts DESC`,
    [windowMinutes, LIVE_POS_BUFFER_MIN]
  );
  return rows;
}

// Ordered track for one vessel over the last `hours` — feeds trail rendering.
async function getTrack(mmsi, hours) {
  const { rows } = await query(
    `SELECT lat, lng, ts, sog, cog, hdt, status
     FROM positions
     WHERE mmsi = $1 AND ts > now() - make_interval(hours => $2::int)
     ORDER BY ts ASC`,
    [mmsi, hours]
  );
  return rows;
}

// Tracks for ALL currently-present vessels in one query (for the "all tracks"
// overlay). Returns rows ordered by mmsi, ts; the caller groups by mmsi.
async function getAllTracks(windowMinutes, hours) {
  const { rows } = await query(
    `SELECT p.mmsi, p.lat, p.lng, p.ts, p.sog
     FROM positions p
     JOIN vessels v ON v.mmsi = p.mmsi
     WHERE v.last_seen > now() - make_interval(mins => $1::int)
       AND p.ts > now() - make_interval(hours => $2::int)
     ORDER BY p.mmsi, p.ts ASC`,
    [windowMinutes, hours]
  );
  return rows;
}

// MMSIs that haven't been historically backfilled yet (most-recently-present
// first, so the vessels on screen get their tracks soonest).
async function getVesselsNeedingBackfill(limit) {
  const { rows } = await query(
    `SELECT mmsi FROM vessels
     WHERE backfilled_at IS NULL
     ORDER BY last_seen DESC
     LIMIT $1`,
    [limit]
  );
  return rows.map((r) => r.mmsi);
}

async function markBackfilled(mmsi) {
  await query(`UPDATE vessels SET backfilled_at = now() WHERE mmsi = $1`, [mmsi]);
}

// Idempotent bulk position insert (used by backfill).
async function insertPositions(positions) {
  if (!positions.length) return 0;
  const pi = buildPositionInsert(positions);
  const res = await query(pi.text, pi.values);
  return res.rowCount;
}

// Detect crossings of one gate over the last `lookbackHours`, upsert into
// gate_crossings. Segment-based (bridges gaps); direction from longitude change
// (west = into Gulf = inbound; east = exports = outbound).
async function detectGateLine(gateLabel, line, lookbackHours) {
  const { a, b } = line;
  const res = await query(
    `WITH params AS (
       SELECT ST_SetSRID(ST_MakeLine(ST_MakePoint($1, $2), ST_MakePoint($3, $4)), 4326) AS wire
     ),
     seq AS (
       SELECT p.mmsi, p.ts, p.geom, p.lng, p.sog, p.draught,
              lag(p.geom) OVER w AS prev_geom,
              lag(p.lng)  OVER w AS prev_lng
       FROM positions p
       WHERE p.ts > now() - make_interval(hours => $6::int)
       WINDOW w AS (PARTITION BY p.mmsi ORDER BY p.ts)
     ),
     crossings AS (
       SELECT s.mmsi, s.ts, s.sog, s.draught,
              CASE WHEN s.lng < s.prev_lng THEN 'inbound' ELSE 'outbound' END AS direction,
              ST_Intersection(p.wire, ST_MakeLine(s.prev_geom, s.geom)) AS pt
       FROM seq s, params p
       WHERE s.prev_geom IS NOT NULL
         AND ST_Crosses(ST_MakeLine(s.prev_geom, s.geom), p.wire)
     )
     INSERT INTO gate_crossings (mmsi, ts, gate, direction, type, sog, draught, cross_lat, cross_lng)
     SELECT c.mmsi, c.ts, $5, c.direction, v.type, c.sog, c.draught,
            ST_Y(c.pt), ST_X(c.pt)
     FROM crossings c
     JOIN vessels v ON v.mmsi = c.mmsi
     WHERE GeometryType(c.pt) = 'POINT'
     ON CONFLICT (mmsi, ts, gate) DO NOTHING`,
    [a.lng, a.lat, b.lng, b.lat, gateLabel, lookbackHours]
  );
  return res.rowCount;
}

// Detect crossings for every gate in the cordon.
async function detectGateCrossings(gates, lookbackHours) {
  let total = 0;
  for (const [label, line] of Object.entries(gates)) {
    total += await detectGateLine(label, line, lookbackHours);
  }
  return total;
}

// Pair consecutive gate crossings into completed passages: a crossing followed
// by a crossing of the OTHER gate in the SAME direction within maxTransitHours.
// Loitering / U-turns never hit both gates, so they're excluded by construction.
async function buildPassages(maxTransitHours, lookbackHours, slowMin) {
  const res = await query(
    `WITH seq AS (
       SELECT mmsi, ts, gate, direction, type, draught,
              lead(ts)        OVER w AS n_ts,
              lead(gate)      OVER w AS n_gate,
              lead(direction) OVER w AS n_dir
       FROM gate_crossings
       WHERE ts > now() - make_interval(hours => $2::int)
       WINDOW w AS (PARTITION BY mmsi ORDER BY ts)
     )
     INSERT INTO passages
       (mmsi, entry_ts, exit_ts, entry_gate, exit_gate, direction, transit_min, type, draught, flags)
     SELECT mmsi, ts, n_ts, gate, n_gate, direction,
            EXTRACT(EPOCH FROM (n_ts - ts)) / 60.0,
            type, draught,
            CASE WHEN EXTRACT(EPOCH FROM (n_ts - ts)) / 60.0 > $3
                 THEN ARRAY['slow'] ELSE ARRAY[]::text[] END
     FROM seq
     WHERE n_gate IS NOT NULL
       AND n_gate <> gate
       AND n_dir = direction
       AND n_ts - ts <= make_interval(hours => $1::int)
     ON CONFLICT (mmsi, entry_ts) DO NOTHING`,
    [maxTransitHours, lookbackHours, slowMin]
  );
  return res.rowCount;
}

// Cordon summary: completed passages (the clean flow number), gross gate
// crossings, plus the anomaly buckets the cordon exists to surface.
async function getCordonSummary(hours, maxTransitHours) {
  const blank = () => ({ total: 0, tankers: 0 });
  const out = {
    hours,
    completed: { inbound: blank(), outbound: blank(), medianTransitMin: null, slow: 0 },
    gross: { inbound: 0, outbound: 0 },
    uTurns: 0,
    incomplete: 0, // entered a gate, no matching exit within max transit time
  };

  const comp = await query(
    `SELECT direction,
            count(*)::int AS total,
            count(*) FILTER (WHERE type ILIKE '%tanker%')::int AS tankers,
            count(*) FILTER (WHERE 'slow' = ANY(flags))::int AS slow
     FROM passages
     WHERE exit_ts > now() - make_interval(hours => $1::int)
     GROUP BY direction`,
    [hours]
  );
  for (const r of comp.rows) {
    if (out.completed[r.direction]) {
      out.completed[r.direction] = { total: r.total, tankers: r.tankers };
      out.completed.slow += r.slow;
    }
  }

  // Transit-time distribution: percentiles + a fixed-width histogram. A median
  // alone hides congestion; a widening p90 / fat upper tail is the slowdown tell.
  const TRANSIT_HIST_MAX = 600; // minutes (10 h) — passages above land in the top bin
  const TRANSIT_HIST_BINS = 12; // 50-min bins
  const dist = await query(
    `SELECT percentile_cont(0.1) WITHIN GROUP (ORDER BY transit_min) AS p10,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY transit_min) AS p50,
            percentile_cont(0.9) WITHIN GROUP (ORDER BY transit_min) AS p90,
            count(*)::int AS n
     FROM passages
     WHERE exit_ts > now() - make_interval(hours => $1::int)
       AND transit_min IS NOT NULL`,
    [hours]
  );
  const hist = await query(
    `SELECT width_bucket(LEAST(transit_min, $2::float8 - 0.001), 0, $2::float8, $3::int) AS bin,
            count(*)::int AS n
     FROM passages
     WHERE exit_ts > now() - make_interval(hours => $1::int)
       AND transit_min IS NOT NULL
     GROUP BY bin ORDER BY bin`,
    [hours, TRANSIT_HIST_MAX, TRANSIT_HIST_BINS]
  );
  const d = dist.rows[0];
  out.completed.medianTransitMin = d.p50 != null ? Math.round(d.p50) : null;
  const binW = TRANSIT_HIST_MAX / TRANSIT_HIST_BINS;
  const counts = new Array(TRANSIT_HIST_BINS).fill(0);
  for (const r of hist.rows) {
    const i = Math.min(Math.max(r.bin - 1, 0), TRANSIT_HIST_BINS - 1); // width_bucket is 1-based
    counts[i] += r.n;
  }
  out.transit = {
    n: d.n,
    p10: d.p10 != null ? Math.round(d.p10) : null,
    p50: d.p50 != null ? Math.round(d.p50) : null,
    p90: d.p90 != null ? Math.round(d.p90) : null,
    binMin: binW,
    histogram: counts.map((c, i) => ({ from: Math.round(i * binW), to: Math.round((i + 1) * binW), count: c })),
  };

  const gross = await query(
    `SELECT direction, count(*)::int AS total
     FROM gate_crossings
     WHERE ts > now() - make_interval(hours => $1::int)
     GROUP BY direction`,
    [hours]
  );
  for (const r of gross.rows) if (out.gross[r.direction] != null) out.gross[r.direction] = r.total;

  // U-turns: a crossing followed by the SAME gate in the opposite direction.
  const uturn = await query(
    `WITH seq AS (
       SELECT mmsi, ts, gate, direction,
              lead(gate)      OVER w AS n_gate,
              lead(direction) OVER w AS n_dir
       FROM gate_crossings
       WHERE ts > now() - make_interval(hours => $1::int)
       WINDOW w AS (PARTITION BY mmsi ORDER BY ts)
     )
     SELECT count(*)::int AS n FROM seq
     WHERE n_gate = gate AND n_dir <> direction`,
    [hours]
  );
  out.uTurns = uturn.rows[0].n;

  // Incomplete: matured gate crossings (had time to complete) that are neither
  // the entry nor the exit of any passage — entered the cordon, didn't transit.
  const incomplete = await query(
    `SELECT count(*)::int AS n
     FROM gate_crossings gc
     WHERE gc.ts > now() - make_interval(hours => $1::int)
       AND gc.ts < now() - make_interval(hours => $2::int)
       AND NOT EXISTS (SELECT 1 FROM passages p
                       WHERE p.mmsi = gc.mmsi AND p.entry_ts = gc.ts)
       AND NOT EXISTS (SELECT 1 FROM passages p
                       WHERE p.mmsi = gc.mmsi AND p.exit_ts = gc.ts)`,
    [hours, maxTransitHours]
  );
  out.incomplete = incomplete.rows[0].n;

  // The vessels behind the totals — newest first, named via the vessels table.
  const list = await query(
    `SELECT p.mmsi, v.name, p.type, p.direction, p.transit_min, p.exit_ts,
            (p.type ILIKE '%tanker%') AS tanker,
            ('slow' = ANY(p.flags)) AS slow
     FROM passages p
     LEFT JOIN vessels v ON v.mmsi = p.mmsi
     WHERE p.exit_ts > now() - make_interval(hours => $1::int)
     ORDER BY p.exit_ts DESC
     LIMIT 60`,
    [hours]
  );
  out.passages = list.rows.map((r) => ({
    mmsi: r.mmsi,
    name: r.name,
    type: r.type,
    direction: r.direction,
    transitMin: r.transit_min != null ? Math.round(r.transit_min) : null,
    exitTs: r.exit_ts,
    tanker: r.tanker,
    slow: r.slow,
  }));

  return out;
}

// Estimate vessel capacity from AIS length (no DWT in the feed). Runs each
// cycle; only fills rows still missing an estimate. Tankers only for now.
async function enrichVessels(f) {
  const res = await query(
    `UPDATE vessels SET
        dwt = round($1::numeric * power(length::numeric / $2::numeric, 3)),
        cargo_capacity_bbl = round($1::numeric * power(length::numeric / $2::numeric, 3)
                                   * $3::numeric * $4::numeric),
        design_draught = $5::float8 * length
     WHERE dwt IS NULL AND length >= $6::int AND type ILIKE '%tanker%'`,
    [f.refDwt, f.refLen, f.cargoFraction, f.bblPerTonne, f.draughtCoef, f.minLengthM]
  );
  return res.rowCount;
}

// Estimated barrel flow from completed tanker passages over the last `hours`.
// Laden fraction uses reported draught vs estimated design draught where
// available, else a direction-based assumption.
async function getFlowSummary(hours, f) {
  const { rows } = await query(
    `WITH calc AS (
       SELECT pa.direction,
              COALESCE(v.cargo_capacity_bbl, 0) AS cap,
              COALESCE(
                CASE WHEN pa.draught IS NOT NULL AND v.design_draught > 0
                  THEN GREATEST(0, LEAST(1,
                       (pa.draught - $2::float8 * v.design_draught)
                       / NULLIF((1 - $2::float8) * v.design_draught, 0)))
                END,
                CASE WHEN pa.direction = 'outbound' THEN $3::float8 ELSE $4::float8 END
              ) AS laden_frac
       FROM passages pa
       JOIN vessels v ON v.mmsi = pa.mmsi
       WHERE pa.exit_ts > now() - make_interval(hours => $1::int)
         AND pa.type ILIKE '%tanker%'
     )
     SELECT direction,
            count(*)::int AS tanker_passages,
            round(COALESCE(sum(cap * laden_frac), 0))::bigint AS barrels
     FROM calc GROUP BY direction`,
    [hours, f.ballastFraction, f.fallbackLadenOut, f.fallbackLadenIn]
  );
  const out = {
    hours,
    outbound: { tankerPassages: 0, barrels: 0 },
    inbound: { tankerPassages: 0, barrels: 0 },
    assumptions: {
      capacity: `DWT≈${f.refDwt}*(L/${f.refLen})³, ${f.bblPerTonne} bbl/t × ${f.cargoFraction} cargo`,
      ladenFallback: `out ${f.fallbackLadenOut}, in ${f.fallbackLadenIn} (when draught missing)`,
    },
  };
  for (const r of rows) {
    if (out[r.direction]) {
      out[r.direction] = { tankerPassages: r.tanker_passages, barrels: Number(r.barrels) };
    }
  }
  return out;
}

// --- Floating storage / anchorage queue (analytics) -------------------------

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Greedy single-link clustering of points within `km`. Cheap (n is small here)
// and good enough to surface anchorage *queues* from a scatter of parked hulls.
function clusterByProximity(points, km) {
  const clusters = [];
  for (const p of points) {
    if (p.lat == null || p.lng == null) continue;
    let host = null;
    for (const c of clusters) {
      if (haversineKm(p.lat, p.lng, c.lat, c.lng) <= km) { host = c; break; }
    }
    if (host) {
      host.lat = (host.lat * host.count + p.lat) / (host.count + 1);
      host.lng = (host.lng * host.count + p.lng) / (host.count + 1);
      host.count += 1;
    } else {
      clusters.push({ lat: p.lat, lng: p.lng, count: 1 });
    }
  }
  return clusters;
}

// Tankers that sat effectively still over the window: parked long enough, never
// strayed far (bbox diagonal), low average speed. Laden+parked ≈ floating
// storage; clusters of them ≈ an anchorage queue. Both are crude-market tells.
async function getFloatingStorage(windowMinutes, hours, st, flow) {
  const { rows } = await query(
    `WITH win AS (
       SELECT p.mmsi, p.lat, p.lng, p.sog, p.ts, p.draught
       FROM positions p
       JOIN vessels v ON v.mmsi = p.mmsi
       WHERE v.last_seen > now() - make_interval(mins => $1::int)
         AND p.ts > now() - make_interval(hours => $2::int)
         AND v.type ILIKE '%tanker%'
     ),
     agg AS (
       SELECT mmsi, count(*)::int AS n, avg(sog) AS avg_sog,
              EXTRACT(EPOCH FROM (max(ts) - min(ts))) / 3600.0 AS span_hours,
              ST_DistanceSphere(ST_MakePoint(min(lng), min(lat)),
                                ST_MakePoint(max(lng), max(lat))) / 1000.0 AS bbox_km
       FROM win GROUP BY mmsi
     ),
     latest AS (
       SELECT DISTINCT ON (mmsi) mmsi, lat, lng, ts, draught
       FROM win ORDER BY mmsi, ts DESC
     )
     SELECT a.mmsi, v.name, v.type, v.cargo_capacity_bbl, v.design_draught,
            a.avg_sog, a.span_hours, a.bbox_km, l.lat, l.lng, l.ts, l.draught,
            CASE WHEN l.draught IS NOT NULL AND v.design_draught > 0
              THEN GREATEST(0, LEAST(1,
                   (l.draught - $6::float8 * v.design_draught)
                   / NULLIF((1 - $6::float8) * v.design_draught, 0)))
            END AS laden_frac
     FROM agg a
     JOIN vessels v ON v.mmsi = a.mmsi
     JOIN latest l ON l.mmsi = a.mmsi
     WHERE a.span_hours >= $3::float8
       AND a.bbox_km <= $4::float8
       AND (a.avg_sog IS NULL OR a.avg_sog <= $5::float8)
     ORDER BY a.span_hours DESC
     LIMIT 400`,
    [windowMinutes, hours, st.minHours, st.maxSpanKm, st.maxAvgSog, flow.ballastFraction]
  );

  const vessels = rows.map((r) => {
    const ladenFrac = r.laden_frac != null ? Number(r.laden_frac) : null;
    const cap = r.cargo_capacity_bbl != null ? Number(r.cargo_capacity_bbl) : null;
    const barrels = (ladenFrac != null && cap != null) ? Math.round(cap * ladenFrac) : null;
    return {
      mmsi: String(r.mmsi), name: r.name, type: r.type, lat: r.lat, lng: r.lng, ts: r.ts,
      parkedHours: Math.round(r.span_hours * 10) / 10,
      avgSog: r.avg_sog != null ? Math.round(r.avg_sog * 100) / 100 : null,
      spanKm: Math.round(r.bbox_km * 10) / 10,
      draught: r.draught != null ? Number(r.draught) : null, ladenFrac, barrels,
    };
  });
  const laden = vessels.filter((v) => v.barrels != null);
  const barrels = laden.reduce((s, v) => s + v.barrels, 0);
  const queues = clusterByProximity(vessels, st.clusterKm)
    .filter((c) => c.count >= 2)
    .sort((a, b) => b.count - a.count)
    .map((c) => ({ lat: c.lat, lng: c.lng, count: c.count }));

  return { hours, parked: vessels.length, ladenCount: laden.length, barrels, queues, vessels: vessels.slice(0, 30) };
}

// --- Export run-rate time series (analytics) --------------------------------

// Bucketed barrel flow from completed tanker passages — turns the single 24 h
// number into a trend with a rolling mean and a z-score of the latest bucket vs
// the trailing distribution (a cheap anomaly band over data we already store).
async function getFlowSeries(days, bucket, flow) {
  const unit = bucket === 'hour' ? 'hour' : 'day';
  const { rows } = await query(
    `WITH calc AS (
       SELECT date_trunc($2::text, pa.exit_ts) AS bucket, pa.direction,
              COALESCE(v.cargo_capacity_bbl, 0) AS cap,
              COALESCE(
                CASE WHEN pa.draught IS NOT NULL AND v.design_draught > 0
                  THEN GREATEST(0, LEAST(1,
                       (pa.draught - $3::float8 * v.design_draught)
                       / NULLIF((1 - $3::float8) * v.design_draught, 0)))
                END,
                CASE WHEN pa.direction = 'outbound' THEN $4::float8 ELSE $5::float8 END
              ) AS laden_frac
       FROM passages pa
       JOIN vessels v ON v.mmsi = pa.mmsi
       WHERE pa.exit_ts > now() - make_interval(days => $1::int)
         AND pa.type ILIKE '%tanker%'
     )
     SELECT bucket, direction, count(*)::int AS passages,
            round(COALESCE(sum(cap * laden_frac), 0))::bigint AS barrels
     FROM calc GROUP BY bucket, direction ORDER BY bucket ASC`,
    [days, unit, flow.ballastFraction, flow.fallbackLadenOut, flow.fallbackLadenIn]
  );

  // Build a dense, gap-filled calendar (missing buckets are real zeros, not
  // absent points) so the sparkline and the stats aren't distorted by gaps.
  const stepMs = unit === 'hour' ? 3600e3 : 86400e3;
  const buckets = [];
  const now = Date.now();
  const span = unit === 'hour' ? days * 24 : days;
  for (let i = span - 1; i >= 0; i--) {
    const t = new Date(Math.floor((now - i * stepMs) / stepMs) * stepMs);
    buckets.push({ bucket: t.toISOString(), outbound: 0, inbound: 0, outPassages: 0, inPassages: 0 });
  }
  const idx = new Map(buckets.map((b, i) => [new Date(b.bucket).getTime(), i]));
  for (const r of rows) {
    const key = Math.floor(new Date(r.bucket).getTime() / stepMs) * stepMs;
    const i = idx.get(key);
    if (i == null) continue;
    if (r.direction === 'outbound') { buckets[i].outbound = Number(r.barrels); buckets[i].outPassages = r.passages; }
    else if (r.direction === 'inbound') { buckets[i].inbound = Number(r.barrels); buckets[i].inPassages = r.passages; }
  }

  return { days, bucket: unit, series: buckets, outbound: seriesStats(buckets.map((b) => b.outbound)) };
}

// Latest bucket vs the trailing mean/σ — a z-score anomaly band, plus a rolling
// mean for the trend line. Trailing excludes the latest point so it isn't graded
// against itself.
function seriesStats(values) {
  const n = values.length;
  if (n < 2) return { latest: n ? values[0] : 0, mean: 0, std: 0, z: 0, trail: 0 };
  const latest = values[n - 1];
  const prior = values.slice(0, n - 1);
  const mean = prior.reduce((s, v) => s + v, 0) / prior.length;
  const variance = prior.reduce((s, v) => s + (v - mean) ** 2, 0) / prior.length;
  const std = Math.sqrt(variance);
  const z = std > 0 ? (latest - mean) / std : 0;
  return {
    latest, trail: Math.round(mean), std: Math.round(std),
    z: Math.round(z * 100) / 100,
  };
}

// --- Gulf activity overview (top-line counts + daily crossings) -------------

// The obvious headline numbers: how many vessels are present right now, and the
// day-by-day completed-passage count (split in/out) over the window.
async function getActivity(windowMinutes, days) {
  const present = await query(
    `WITH live AS (
       SELECT DISTINCT ON (p.mmsi) v.type
       FROM vessels v JOIN positions p ON p.mmsi = v.mmsi
       WHERE v.last_seen > now() - make_interval(mins => $1::int)
       ORDER BY p.mmsi, p.ts DESC
     )
     SELECT count(*)::int AS ships,
            count(*) FILTER (WHERE type ILIKE '%tanker%')::int AS tankers
     FROM live`,
    [windowMinutes]
  );
  const { rows } = await query(
    `SELECT date_trunc('day', exit_ts) AS bucket, direction, count(*)::int AS n
     FROM passages
     WHERE exit_ts > now() - make_interval(days => $1::int)
     GROUP BY bucket, direction ORDER BY bucket ASC`,
    [days]
  );
  // Gap-filled daily calendar so absent days are real zeros, not missing bars.
  const stepMs = 86400e3, now = Date.now();
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const t = new Date(Math.floor((now - i * stepMs) / stepMs) * stepMs);
    series.push({ date: t.toISOString(), inbound: 0, outbound: 0, total: 0 });
  }
  const idx = new Map(series.map((b, i) => [new Date(b.date).getTime(), i]));
  for (const r of rows) {
    const i = idx.get(Math.floor(new Date(r.bucket).getTime() / stepMs) * stepMs);
    if (i == null) continue;
    if (r.direction === 'outbound') series[i].outbound = r.n;
    else if (r.direction === 'inbound') series[i].inbound = r.n;
    series[i].total = series[i].inbound + series[i].outbound;
  }
  return { days, present: present.rows[0], series };
}

// --- Outbound destinations (origin-destination, analytics) ------------------

// AIS `dest` is free text, but in the Gulf it's overwhelmingly UN/LOCODE
// (AEFJR = UAE Fujairah, CNQIN = China Qingdao) — the leading two letters are
// the ISO country. So: drop placeholders, try full-name keywords, then fall
// back to the LOCODE country prefix. Region by country code:
const LOCODE_REGION = {
  AE: 'Gulf / local', SA: 'Gulf / local', QA: 'Gulf / local', KW: 'Gulf / local',
  BH: 'Gulf / local', OM: 'Gulf / local', IR: 'Gulf / local', IQ: 'Gulf / local', YE: 'Gulf / local',
  CN: 'China', IN: 'India', LK: 'India', PK: 'India',
  KR: 'South Korea', JP: 'Japan',
  SG: 'SE Asia', MY: 'SE Asia', TH: 'SE Asia', ID: 'SE Asia', VN: 'SE Asia', PH: 'SE Asia', TW: 'SE Asia',
  EG: 'West / Suez', IT: 'West / Suez', NL: 'West / Suez', GR: 'West / Suez', ES: 'West / Suez',
  FR: 'West / Suez', GB: 'West / Suez', US: 'West / Suez', TR: 'West / Suez', SD: 'West / Suez',
  ZA: 'West / Suez', PT: 'West / Suez', GI: 'West / Suez', MT: 'West / Suez',
};
// Full English names / well-known ports — checked before the LOCODE fallback.
const DEST_REGIONS = [
  ['China', /CHINA|NINGBO|QINGDAO|RIZHAO|ZHOUSHAN|DALIAN|TIANJIN|YANTAI|HUIZHOU|LANSHAN|YANGSHAN|ZHANJIANG|QUANZHOU/],
  ['India', /INDIA|SIKKA|JAMNAGAR|VADINAR|MUNDRA|COCHIN|KOCHI|CHENNAI|PARADIP|MUMBAI|NHAVA|HAZIRA|ENNORE|MANGALORE/],
  ['South Korea', /KOREA|ULSAN|YEOSU|YOSU|DAESAN|ONSAN/],
  ['Japan', /JAPAN|CHIBA|YOKOHAMA|KASHIMA|MIZUSHIMA|NEGISHI|KAWASAKI/],
  ['SE Asia', /SINGAPORE|MALACCA|MALAYSIA|PASIR|PENGERANG|MAP TA PHUT|THAILAND|INDONESIA|MERAK|VIETNAM/],
  ['West / Suez', /SUEZ|SUMED|SIDI|KERIR|ROTTERDAM|AUGUSTA|TRIESTE|GIBRALTAR|EUROPE|HOUSTON|TEXAS/],
  ['Gulf / local', /FUJAIRAH|JEBEL|RUWAIS|RAS TANURA|JUAYMAH|JUBAIL|BANDAR|KHARG|BASR|BASHRA|KUWAIT|HAMRIYAH|SHARJAH|RAS LAFFAN|HALUL|SOHAR|SALALAH|SHINAS|DUBAI|ABU DHABI|KHOR ?FAKKAN|\bOMAN\b|\bUAE\b/],
];

function normalizeDestination(dest) {
  const s = String(dest).trim().toUpperCase();
  if (!s) return 'Unknown';
  // Charter / placeholder markers (no committed destination) — checked first so
  // tokens like "ORDER" aren't mistaken for a 5-char LOCODE below.
  if (/^(FOR ?ORDERS?|TO ?ORDER|ORDERS?|OPL|TBN|TBA|KAZ|UNKNOWN|N\/?A)\b/.test(s) || /\bOWNER\b/.test(s)) return 'Unknown';
  for (const [region, re] of DEST_REGIONS) if (re.test(s)) return region;
  const lo = s.match(/\b([A-Z]{2})[A-Z]{3}\b/);   // UN/LOCODE country prefix
  if (lo && LOCODE_REGION[lo[1]]) return LOCODE_REGION[lo[1]];
  const cc = s.match(/^([A-Z]{2})\b/);            // bare "AE FJR" style
  if (cc && LOCODE_REGION[cc[1]]) return LOCODE_REGION[cc[1]];
  return 'Other';
}

// Latest declared destination per tanker on station, bucketed into market
// regions — a coarse read on where current Gulf crude is pointed.
async function getOutboundDestinations(windowMinutes) {
  const { rows } = await query(
    `SELECT DISTINCT ON (p.mmsi) p.mmsi, p.dest, v.name
     FROM positions p
     JOIN vessels v ON v.mmsi = p.mmsi
     WHERE v.last_seen > now() - make_interval(mins => $1::int)
       AND v.type ILIKE '%tanker%'
       AND p.dest IS NOT NULL AND btrim(p.dest) <> ''
     ORDER BY p.mmsi, p.ts DESC`,
    [windowMinutes]
  );
  const regions = new Map();
  let total = 0;
  for (const r of rows) {
    const region = normalizeDestination(r.dest);
    regions.set(region, (regions.get(region) || 0) + 1);
    total++;
  }
  const ranked = [...regions.entries()]
    .map(([region, count]) => ({ region, count }))
    .sort((a, b) => b.count - a.count);
  return { total, regions: ranked };
}

// --- Integrity layer (Phase 4) ----------------------------------------------

// Dark ships: detection of *absence*. Open an event when a vessel last seen
// between darkMin and darkMax ago vanished from the INTERIOR of the box while
// under way (so it can't just have sailed out of frame, and wasn't sitting at
// anchor). Idempotent: one open event per MMSI at a time. Returns the count
// opened this cycle.
async function openDarkEvents(bbox, ig) {
  const res = await query(
    `WITH latest AS (
       SELECT DISTINCT ON (p.mmsi)
              p.mmsi, v.last_seen, p.lat, p.lng, p.sog, v.type
       FROM vessels v
       JOIN positions p ON p.mmsi = v.mmsi
       WHERE v.last_seen BETWEEN now() - make_interval(hours => $1::int)
                             AND now() - make_interval(mins  => $2::int)
       ORDER BY p.mmsi, p.ts DESC
     )
     INSERT INTO dark_events (mmsi, went_dark_ts, last_lat, last_lng, last_sog, type)
     SELECT l.mmsi, l.last_seen, l.lat, l.lng, l.sog, l.type
     FROM latest l
     WHERE l.lat BETWEEN $3::float8 AND $4::float8
       AND l.lng BETWEEN $5::float8 AND $6::float8
       AND (l.sog IS NULL OR l.sog >= $7::float8)
       -- Commercially significant traffic only: tankers/cargo are the desk's
       -- concern, and small craft (fishing, pleasure) have spotty AIS by nature.
       AND (l.type ILIKE '%tanker%' OR l.type ILIKE '%cargo%')
       AND NOT EXISTS (SELECT 1 FROM dark_events d
                       WHERE d.mmsi = l.mmsi AND d.resumed_ts IS NULL)
       -- A vessel that crossed a cordon gate around when it vanished was
       -- transiting out, not going dark — exclude it so the signal is real.
       AND NOT EXISTS (SELECT 1 FROM gate_crossings gc
                       WHERE gc.mmsi = l.mmsi
                         AND gc.ts > l.last_seen - make_interval(hours => $8::int))
     ON CONFLICT (mmsi, went_dark_ts) DO NOTHING`,
    [
      ig.darkMaxHours, ig.darkMinHours * 60,
      bbox.lat_min + ig.darkEdgeDeg, bbox.lat_max - ig.darkEdgeDeg,
      bbox.long_min + ig.darkEdgeDeg, bbox.long_max - ig.darkEdgeDeg,
      ig.darkMinSog, ig.darkExitGraceHours,
    ]
  );
  return res.rowCount;
}

// Close open dark events whose MMSI has transmitted again (a fresh fix later
// than the dark gap): record how long it was dark and how far it jumped. A
// re-appearance far from where it vanished is the spoof/identity tell, flagged
// 'jumped'. Returns the count resumed this cycle.
async function resumeDarkEvents(ig) {
  const res = await query(
    `UPDATE dark_events d
     SET resumed_ts = r.ts,
         gap_min    = EXTRACT(EPOCH FROM (r.ts - d.went_dark_ts)) / 60.0,
         resume_lat = r.lat,
         resume_lng = r.lng,
         resume_km  = ST_DistanceSphere(ST_MakePoint(d.last_lng, d.last_lat),
                                        ST_MakePoint(r.lng, r.lat)) / 1000.0,
         flags = CASE
                   WHEN ST_DistanceSphere(ST_MakePoint(d.last_lng, d.last_lat),
                                          ST_MakePoint(r.lng, r.lat)) / 1000.0 > $2::float8
                   THEN ARRAY['jumped'] ELSE ARRAY[]::text[] END
     FROM (
       SELECT DISTINCT ON (p.mmsi) p.mmsi, p.ts, p.lat, p.lng
       FROM positions p
       JOIN dark_events de ON de.mmsi = p.mmsi AND de.resumed_ts IS NULL
       ORDER BY p.mmsi, p.ts DESC
     ) r
     WHERE d.mmsi = r.mmsi AND d.resumed_ts IS NULL
       AND r.ts > d.went_dark_ts + make_interval(mins => $1::int)`,
    [ig.darkMinHours * 60, ig.darkJumpKm]
  );
  return res.rowCount;
}

async function detectDarkEvents(bbox, ig) {
  const resumed = await resumeDarkEvents(ig); // close first so a re-appeared
  const opened = await openDarkEvents(bbox, ig); // ship isn't re-opened same cycle
  return { opened, resumed };
}

// Current slow vessels (latest fix per MMSI) paired by proximity. Shared by the
// extend + insert steps of STS detection. Params: $1 live window (min), $2 max
// SoG (kn), $3 max separation (m); $5/$6/$7 anchorage lat/lng/radiusKm arrays to
// exclude ($4 is the episode-gap, used by the callers' bodies). Pairs are
// canonical (a < b) and must involve a tanker — the shadow-fleet STS signal,
// which also strips the tug/passenger/cargo harbour clustering noise.
const STS_PAIRS_CTE = `
  WITH latest AS (
    SELECT DISTINCT ON (p.mmsi) p.mmsi, p.lat, p.lng, p.sog, p.geom, v.type
    FROM vessels v
    JOIN positions p ON p.mmsi = v.mmsi
    WHERE v.last_seen > now() - make_interval(mins => $1::int)
    ORDER BY p.mmsi, p.ts DESC
  ),
  slow AS (SELECT * FROM latest WHERE sog IS NULL OR sog <= $2::float8),
  pairs AS (
    SELECT a.mmsi AS ammsi, b.mmsi AS bmmsi,
           ST_DistanceSphere(a.geom, b.geom) AS dist,
           a.lat AS lat, a.lng AS lng
    FROM slow a
    JOIN slow b
      ON a.mmsi < b.mmsi
     AND ST_DWithin(a.geom::geography, b.geom::geography, $3::float8)
     AND (a.type ILIKE '%tanker%' OR b.type ILIKE '%tanker%')
     AND NOT EXISTS (
       SELECT 1 FROM unnest($5::float8[], $6::float8[], $7::float8[]) AS az(lat, lng, radkm)
       WHERE ST_DistanceSphere(a.geom, ST_SetSRID(ST_MakePoint(az.lng, az.lat), 4326)) <= az.radkm * 1000
     )
  )`;

// STS candidates: sustained slow pairs held alongside. Extend any open episode
// (last seen within stsGapMin), then open a new episode for pairs that aren't
// continuing one. Two steps so a brief separation starts a fresh episode rather
// than silently stitching across a gap.
async function detectStsCandidates(ig, liveWindowMin, anchorages = []) {
  const azLat = anchorages.map((a) => a.lat);
  const azLng = anchorages.map((a) => a.lng);
  const azRad = anchorages.map((a) => a.radiusKm);
  const params = [liveWindowMin, ig.stsMaxSog, ig.stsMaxDistM, ig.stsGapMin, azLat, azLng, azRad];

  const ext = await query(
    `${STS_PAIRS_CTE}
     UPDATE sts_candidates s
     SET last_ts    = now(),
         dur_min    = EXTRACT(EPOCH FROM (now() - s.first_ts)) / 60.0,
         min_dist_m = LEAST(s.min_dist_m, pr.dist),
         last_lat   = pr.lat,
         last_lng   = pr.lng
     FROM pairs pr
     WHERE s.mmsi_a = pr.ammsi AND s.mmsi_b = pr.bmmsi
       AND s.last_ts > now() - make_interval(mins => $4::int)`,
    params
  );

  const ins = await query(
    `${STS_PAIRS_CTE}
     INSERT INTO sts_candidates
       (mmsi_a, mmsi_b, first_ts, last_ts, dur_min, min_dist_m, last_lat, last_lng)
     SELECT pr.ammsi, pr.bmmsi, now(), now(), 0, pr.dist, pr.lat, pr.lng
     FROM pairs pr
     WHERE NOT EXISTS (
       SELECT 1 FROM sts_candidates s
       WHERE s.mmsi_a = pr.ammsi AND s.mmsi_b = pr.bmmsi
         AND s.last_ts > now() - make_interval(mins => $4::int)
     )
     ON CONFLICT (mmsi_a, mmsi_b, first_ts) DO NOTHING`,
    params
  );

  return { opened: ins.rowCount, extended: ext.rowCount };
}

// Read model for the integrity dashboard: current dark ships, active STS
// candidates, and spoofing signals (static identity flags + impossible jumps).
async function getIntegritySummary(hours, ig, liveWindowMin) {
  // Currently dark: open events that went quiet within the window (older
  // never-resumed ones have effectively left, so they fall out of the count).
  const dark = await query(
    `SELECT mmsi, type, went_dark_ts,
            EXTRACT(EPOCH FROM (now() - went_dark_ts)) / 60.0 AS minutes_dark,
            last_lat, last_lng, last_sog
     FROM dark_events
     WHERE resumed_ts IS NULL AND went_dark_ts > now() - make_interval(hours => $1::int)
     ORDER BY went_dark_ts DESC
     LIMIT 30`,
    [hours]
  );
  const darkCount = await query(
    `SELECT count(*)::int AS n FROM dark_events
     WHERE resumed_ts IS NULL AND went_dark_ts > now() - make_interval(hours => $1::int)`,
    [hours]
  );
  const darkNames = await joinNames(dark.rows.map((r) => r.mmsi));
  const resumedJumps = await query(
    `SELECT count(*)::int AS n FROM dark_events
     WHERE resumed_ts > now() - make_interval(hours => $1::int)
       AND 'jumped' = ANY(flags)`,
    [hours]
  );

  const sts = await query(
    `SELECT s.mmsi_a, s.mmsi_b, s.dur_min, s.min_dist_m, s.last_lat, s.last_lng,
            va.name AS name_a, vb.name AS name_b, va.type AS type_a, vb.type AS type_b
     FROM sts_candidates s
     JOIN vessels va ON va.mmsi = s.mmsi_a
     JOIN vessels vb ON vb.mmsi = s.mmsi_b
     WHERE s.last_ts > now() - make_interval(mins => $1::int)
       AND s.dur_min >= $2::float8
     ORDER BY s.dur_min DESC
     LIMIT 30`,
    [ig.stsGapMin, ig.stsMinDurMin]
  );
  const stsCount = await query(
    `SELECT count(*)::int AS n FROM sts_candidates
     WHERE last_ts > now() - make_interval(mins => $1::int) AND dur_min >= $2::float8`,
    [ig.stsGapMin, ig.stsMinDurMin]
  );

  const jumps = await query(
    `WITH seq AS (
       SELECT p.mmsi, p.ts, p.lat, p.lng,
              lag(p.ts)  OVER w AS p_ts,
              lag(p.lat) OVER w AS p_lat,
              lag(p.lng) OVER w AS p_lng
       FROM positions p
       WHERE p.ts > now() - make_interval(hours => $1::int)
       WINDOW w AS (PARTITION BY p.mmsi ORDER BY p.ts)
     ),
     j AS (
       SELECT mmsi, ts,
              ST_DistanceSphere(ST_MakePoint(p_lng, p_lat), ST_MakePoint(lng, lat)) / 1000.0 AS km,
              EXTRACT(EPOCH FROM (ts - p_ts)) / 3600.0 AS hrs
       FROM seq WHERE p_ts IS NOT NULL AND ts > p_ts
     )
     SELECT j.mmsi, v.name, v.type,
            max(km / hrs / 1.852)::numeric(10,1) AS max_kn,
            max(km)::numeric(10,1) AS max_km,
            count(*)::int AS n
     FROM j JOIN vessels v ON v.mmsi = j.mmsi
     WHERE km >= $2::float8 AND (km / hrs / 1.852) > $3::float8
     GROUP BY j.mmsi, v.name, v.type
     ORDER BY max_kn DESC
     LIMIT 20`,
    [hours, ig.jumpMinDistKm, ig.jumpMaxSpeedKn]
  );

  // Flag-hopping / identity mutation: an MMSI that changed flag or (worse) IMO
  // within the window. A hull's IMO is permanent, so an IMO change is near-
  // definitive identity fraud; reflagging is a classic shadow-fleet move.
  const hops = await query(
    `SELECT ic.mmsi, v.name, v.type,
            count(*) FILTER (WHERE field = 'flag')::int AS flag_hops,
            count(*) FILTER (WHERE field = 'imo')::int  AS imo_changes,
            (array_agg(new_val ORDER BY ts DESC) FILTER (WHERE field = 'flag'))[1] AS latest_flag
     FROM identity_changes ic
     JOIN vessels v ON v.mmsi = ic.mmsi
     WHERE ic.ts > now() - make_interval(hours => $1::int)
     GROUP BY ic.mmsi, v.name, v.type
     HAVING count(*) FILTER (WHERE field IN ('flag', 'imo')) > 0
     ORDER BY imo_changes DESC, flag_hops DESC
     LIMIT 20`,
    [hours]
  );

  // Static identity flags over the vessels currently on station.
  const live = await getLiveVessels(liveWindowMin);
  const identity = [];
  for (const v of live) {
    const flags = integrity.identityFlags(
      { mmsi: v.mmsi, imo: v.imo, type: v.type, length: v.length || 0 },
      ig
    );
    if (flags.length) identity.push({ mmsi: v.mmsi, name: v.name, type: v.type, flags });
  }

  // --- Sanctions watchlist + composite shadow-fleet risk (row 2) -------------
  // Two read models built from signals already computed above, so no extra
  // round-trips: (1) live vessels matching the operator's designated-vessel
  // watchlist, (2) every flagged hull scored by fusing its behavioural tells.
  const wl = sanctions.indexWatchlist(sanctions.loadWatchlist());
  const liveById = new Map(live.map((v) => [String(v.mmsi), v]));

  // Per-MMSI tell accumulator, carrying a name/type/position for display+locate.
  const agg = new Map();
  const touch = (mmsi, name, type) => {
    const id = String(mmsi);
    let a = agg.get(id);
    if (!a) {
      const lv = liveById.get(id);
      a = {
        mmsi: id,
        name: name || (lv && lv.name) || null,
        type: type || (lv && lv.type) || null,
        lat: lv ? lv.lat : null,
        lng: lv ? lv.lng : null,
        tells: {},
      };
      agg.set(id, a);
    } else if (!a.name && name) {
      a.name = name;
    }
    return a;
  };

  for (const r of dark.rows) {
    const a = touch(r.mmsi, darkNames.get(String(r.mmsi)), r.type);
    a.tells.dark = true;
    if (a.lat == null) { a.lat = r.last_lat; a.lng = r.last_lng; } // dark ⇒ off station
  }
  for (const r of sts.rows) {
    touch(r.mmsi_a, r.name_a, r.type_a).tells.sts = true;
    touch(r.mmsi_b, r.name_b, r.type_b).tells.sts = true;
  }
  for (const r of jumps.rows) touch(r.mmsi, r.name, r.type).tells.jump = true;
  for (const r of hops.rows) {
    const a = touch(r.mmsi, r.name, r.type);
    if (r.imo_changes > 0) a.tells.imoSwap = true;
    if (r.flag_hops > 0) a.tells.reflag = true;
  }
  for (const f of identity) {
    const a = touch(f.mmsi, f.name, f.type);
    if (f.flags.includes('bad-imo')) a.tells.badImo = true;
    if (f.flags.includes('no-imo')) a.tells.noImo = true;
    if (f.flags.includes('odd-mmsi')) a.tells.oddMmsi = true;
  }

  // Cross-match the watchlist against who's on station now.
  const matches = [];
  if (wl.size) {
    for (const v of live) {
      const hit = sanctions.matchVessel(v, wl);
      if (!hit) continue;
      matches.push({
        mmsi: String(v.mmsi), imo: v.imo, name: v.name, type: v.type, flag: v.flag,
        lat: v.lat, lng: v.lng, ts: v.ts, matchedOn: hit.on,
        program: hit.entry.program, listed: hit.entry.listed, note: hit.entry.note,
      });
      touch(v.mmsi, v.name, v.type).tells.watchlist = true;
    }
    matches.sort((a, b) => (b.matchedOn === 'imo') - (a.matchedOn === 'imo'));
  }

  // Score + rank flagged hulls (worst first).
  const scored = [];
  for (const a of agg.values()) {
    const score = integrity.shadowFleetScore(a.tells);
    if (score <= 0) continue;
    scored.push({
      mmsi: a.mmsi, name: a.name, type: a.type, lat: a.lat, lng: a.lng, score,
      reasons: integrity.riskReasons(a.tells), watchlisted: !!a.tells.watchlist,
    });
  }
  scored.sort((x, y) => y.score - x.score);

  return {
    hours,
    dark: {
      openCount: darkCount.rows[0].n,
      resumedJumps: resumedJumps.rows[0].n,
      open: dark.rows.map((r) => ({
        mmsi: r.mmsi,
        name: darkNames.get(String(r.mmsi)) || null,
        type: r.type,
        minutesDark: Math.round(r.minutes_dark),
        lat: r.last_lat,
        lng: r.last_lng,
        sog: r.last_sog,
      })),
    },
    sts: {
      count: stsCount.rows[0].n,
      active: sts.rows.map((r) => ({
        a: r.mmsi_a, b: r.mmsi_b, nameA: r.name_a, nameB: r.name_b,
        typeA: r.type_a, typeB: r.type_b,
        durMin: Math.round(r.dur_min),
        distM: r.min_dist_m != null ? Math.round(r.min_dist_m) : null,
        lat: r.last_lat, lng: r.last_lng,
      })),
    },
    spoofing: {
      identityCount: identity.length,
      identity: identity.slice(0, 30),
      jumps: jumps.rows.map((r) => ({
        mmsi: r.mmsi, name: r.name, type: r.type,
        maxKn: Number(r.max_kn), maxKm: Number(r.max_km), n: r.n,
      })),
      hopCount: hops.rows.length,
      hops: hops.rows.map((r) => ({
        mmsi: r.mmsi, name: r.name, type: r.type,
        flagHops: r.flag_hops, imoChanges: r.imo_changes,
        latestFlag: r.latest_flag,
      })),
    },
    watchlist: {
      size: wl.size,              // designated vessels the operator has loaded
      onStation: matches.length,  // of those, how many are present now
      matches: matches.slice(0, 20),
    },
    shadowFleet: {
      flaggedCount: scored.length, // hulls with any tell in the window
      scored: scored.slice(0, 12),
    },
  };
}

// Helper: map mmsi -> name for a set of MMSIs (used to label dark events).
async function joinNames(mmsis) {
  const out = new Map();
  if (!mmsis.length) return out;
  const { rows } = await query(
    `SELECT mmsi, name FROM vessels WHERE mmsi = ANY($1::bigint[])`,
    [mmsis]
  );
  for (const r of rows) out.set(String(r.mmsi), r.name);
  return out;
}

async function prunePositions(days) {
  const { rowCount } = await query(
    `DELETE FROM positions WHERE ts < now() - make_interval(days => $1::int)`,
    [days]
  );
  return rowCount;
}

async function recordRun({ vesselCount, ok, error }) {
  await query(
    `INSERT INTO ingest_runs (finished_at, vessel_count, ok, error)
     VALUES (now(), $1, $2, $3)`,
    [vesselCount, ok, error || null]
  );
}

module.exports = {
  getPool,
  query,
  buildVesselUpsert,
  buildPositionInsert,
  saveSnapshot,
  getLiveVessels,
  getTrack,
  getAllTracks,
  getVesselsNeedingBackfill,
  markBackfilled,
  insertPositions,
  detectGateCrossings,
  buildPassages,
  getCordonSummary,
  enrichVessels,
  getFlowSummary,
  getFloatingStorage,
  getFlowSeries,
  getActivity,
  getOutboundDestinations,
  normalizeDestination,
  detectDarkEvents,
  detectStsCandidates,
  getIntegritySummary,
  prunePositions,
  recordRun,
};
