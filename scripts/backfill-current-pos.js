'use strict';

/**
 * One-time seed of the denormalized vessels.cur_* columns from the latest
 * position per vessel in the positions fact table. Run once after the schema
 * migration that adds the columns; from then on buildVesselUpsert keeps them
 * fresh on every ingest cycle.
 *
 *   node scripts/backfill-current-pos.js
 *
 * Idempotent: re-running only advances cur_ts forward, never rewinds it.
 *
 * The heavy DISTINCT ON scan is materialized into a TEMP table first (which
 * only reads positions), so the UPDATE that actually locks vessels rows is a
 * fast ~12k-row join. That keeps the vessels lock window to seconds and avoids
 * deadlocking against the live ingest worker, which upserts vessels each cycle.
 * A short retry loop absorbs the occasional deadlock if the windows still overlap.
 */

require('../lib/loadenv');
const db = require('../lib/db');

async function attempt() {
  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL statement_timeout = 0');
    await client.query(`
      CREATE TEMP TABLE latest_pos ON COMMIT DROP AS
      SELECT DISTINCT ON (mmsi)
        mmsi, lat, lng, sog, cog, hdt, rot, draught, status, dest, eta, ts
      FROM positions
      ORDER BY mmsi, ts DESC`);
    const res = await client.query(`
      UPDATE vessels v SET
        cur_lat = lp.lat, cur_lng = lp.lng, cur_sog = lp.sog, cur_cog = lp.cog,
        cur_hdt = lp.hdt, cur_rot = lp.rot, cur_draught = lp.draught,
        cur_status = lp.status, cur_dest = lp.dest, cur_eta = lp.eta, cur_ts = lp.ts
      FROM latest_pos lp
      WHERE v.mmsi = lp.mmsi
        AND (v.cur_ts IS NULL OR lp.ts > v.cur_ts)`);
    await client.query('COMMIT');
    return res.rowCount;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function main() {
  console.log('[backfill] seeding vessels.cur_* from latest positions …');
  const t = Date.now();
  const maxTries = 4;
  for (let i = 1; i <= maxTries; i++) {
    try {
      const n = await attempt();
      console.log(`[backfill] updated ${n} vessels in ${((Date.now() - t) / 1000).toFixed(1)}s`);
      break;
    } catch (e) {
      const retryable = /deadlock|could not serialize|timeout/i.test(e.message);
      if (retryable && i < maxTries) {
        console.warn(`[backfill] attempt ${i} failed (${e.message}); retrying …`);
        await new Promise((r) => setTimeout(r, 2000 * i));
        continue;
      }
      throw e;
    }
  }
  await db.getPool().end();
}

main().catch((e) => {
  console.error('[backfill] failed:', e.message);
  process.exit(1);
});
