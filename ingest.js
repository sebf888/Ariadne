'use strict';

/**
 * Continuous ingestion worker — the spine of the data asset.
 *
 * Every INGEST_INTERVAL_MS: pull the SoH area from Marinesia, upsert vessels,
 * append positions (idempotent), prune old rows. Runs as a standalone always-on
 * process (`npm run ingest`) so history is gap-free and never viewer-dependent.
 *
 * Also exports runCycle() so the web server can trigger a one-off ingest.
 */

require('./lib/loadenv');
const { fetchArea, fetchHistory, buildSnapshot, buildTrack } = require('./lib/marinesia');
const db = require('./lib/db');
const cfg = require('./lib/config');

let lastPrune = 0;
const PRUNE_EVERY_MS = 6 * 60 * 60 * 1000; // prune at most every 6h

// Historical backfills per cycle. With tiled ingestion the live poll spends
// most of the 5/min budget on tiles (1 priority + TILES_PER_CYCLE rotating), so
// backfill drops to 1. The global limiter in lib/marinesia caps total calls.
const BACKFILL_PER_CYCLE = Number(process.env.BACKFILL_PER_CYCLE || 1);

// Rotating (non-priority) tiles fetched per cycle. Priority tiles (the cordon)
// are fetched every cycle; the rest round-robin so a full AOI sweep completes
// every ceil(nRotating / TILES_PER_CYCLE) cycles — kept well under the dark-ship
// and live-window thresholds.
const TILES_PER_CYCLE = Number(process.env.TILES_PER_CYCLE || 3);
let tileCursor = 0;

// Fetch this cycle's slice of the AOI: every priority tile + a rotating batch.
// Returns the merged raw vessel list (buildSnapshot dedupes overlaps at seams)
// and the tile names touched, for logging.
async function fetchAoi(key) {
  const priority = cfg.TILES.filter((t) => t.priority);
  const rotating = cfg.TILES.filter((t) => !t.priority);
  const batch = [...priority];
  const n = Math.min(TILES_PER_CYCLE, rotating.length);
  for (let i = 0; i < n; i++) {
    batch.push(rotating[tileCursor % rotating.length]);
    tileCursor++;
  }
  let raw = [];
  for (const t of batch) {
    const part = await fetchArea(t, key);
    if (part.length >= 2000) {
      console.warn(`[ingest] tile ${t.name} hit the 2000 cap (${part.length}) — split it`);
    }
    raw = raw.concat(part);
  }
  return { raw, tiles: batch.map((t) => t.name) };
}

// One-time historical track pull for vessels we haven't backfilled yet, so
// trails aren't sparse. Bounded per cycle; new entrants get picked up over time.
async function runBackfill(key) {
  if (BACKFILL_PER_CYCLE <= 0) return { vessels: 0, points: 0 };
  const mmsis = await db.getVesselsNeedingBackfill(BACKFILL_PER_CYCLE);
  let vessels = 0;
  let points = 0;
  for (const mmsi of mmsis) {
    try {
      const raw = await fetchHistory({ mmsi }, key);
      points += await db.insertPositions(buildTrack(raw, mmsi));
      await db.markBackfilled(mmsi); // mark even if empty, so we don't retry forever
      vessels++;
    } catch (e) {
      console.error(`[backfill] mmsi=${mmsi} failed: ${e.message}`); // leave NULL to retry
    }
  }
  return { vessels, points };
}

async function runCycle() {
  const key = process.env.MARINESIA_API_KEY;
  if (!key) throw new Error('MARINESIA_API_KEY is not set');

  const startedAt = new Date();
  const { raw, tiles } = await fetchAoi(key);
  const { vessels, positions } = buildSnapshot(raw, startedAt);

  const { inserted } = await db.saveSnapshot(vessels, positions);

  await db.enrichVessels(cfg.FLOW).catch((e) => console.error('[enrich]', e.message));

  const backfill = await runBackfill(key);

  const crossings = await db.detectGateCrossings(cfg.GATES, cfg.CROSSINGS_LOOKBACK_HOURS);
  const passages = await db.buildPassages(
    cfg.MAX_TRANSIT_HOURS, cfg.CROSSINGS_LOOKBACK_HOURS, cfg.SLOW_TRANSIT_MIN
  );

  // Integrity layer: dark ships (absence) + STS candidates (proximity). Both
  // are cross-cycle stateful, so they run every cycle off the same fresh fixes.
  const dark = await db.detectDarkEvents(cfg.BBOX, cfg.INTEGRITY);
  const sts = await db.detectStsCandidates(cfg.INTEGRITY, cfg.LIVE_WINDOW_MIN, cfg.ANCHORAGES);

  let pruned = 0;
  if (Date.now() - lastPrune > PRUNE_EVERY_MS) {
    pruned = await db.prunePositions(cfg.POSITIONS_RETENTION_DAYS);
    lastPrune = Date.now();
  }

  await db.recordRun({ vesselCount: vessels.length, ok: true }).catch(() => {});

  return { seen: raw.length, stored: vessels.length, inserted, backfill, crossings, passages, dark, sts, pruned, tiles };
}

async function loop() {
  const nRotating = cfg.TILES.filter((t) => !t.priority).length;
  const sweepCycles = Math.ceil(nRotating / TILES_PER_CYCLE);
  console.log(
    `[ingest] worker started — every ${cfg.INGEST_INTERVAL_MS}ms over ${cfg.TILES.length} ` +
    `tiles (${cfg.TILES.filter((t) => t.priority).map((t) => t.name).join(',')} every cycle, ` +
    `${TILES_PER_CYCLE} rotating/cycle ⇒ full sweep every ${sweepCycles} cycles)`
  );
  // Sequential loop (await then schedule) so a slow cycle never overlaps the next.
  for (;;) {
    const t0 = Date.now();
    try {
      const r = await runCycle();
      console.log(
        `[ingest] ${new Date().toISOString()} tiles=${r.tiles.join('+')} ` +
        `seen=${r.seen} stored=${r.stored} ` +
        `new=${r.inserted} backfill=${r.backfill.vessels}/${r.backfill.points}pts ` +
        `gatecross+=${r.crossings} passages+=${r.passages} ` +
        `dark=${r.dark.opened}+/${r.dark.resumed}- sts=${r.sts.opened}+/${r.sts.extended}~` +
        `${r.pruned ? ` pruned=${r.pruned}` : ''} (${Date.now() - t0}ms)`
      );
    } catch (e) {
      console.error(`[ingest] cycle failed: ${e.message}`);
      await db.recordRun({ vesselCount: null, ok: false, error: e.message }).catch(() => {});
    }
    const elapsed = Date.now() - t0;
    await new Promise((res) => setTimeout(res, Math.max(0, cfg.INGEST_INTERVAL_MS - elapsed)));
  }
}

module.exports = { runCycle, loop, fetchAoi };

// Run as a standalone worker when invoked directly.
if (require.main === module) {
  loop().catch((e) => {
    console.error('[ingest] fatal:', e);
    process.exit(1);
  });
}
