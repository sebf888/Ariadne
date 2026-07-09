'use strict';

/**
 * Seed the persistent daily_* rollups from whatever history is currently in the
 * database (bounded by the 7-day positions retention for storage; passages go
 * back further for flows). Run once after the migration that adds the tables;
 * from then on the ingest loop keeps them current via db.rollupPendingDays().
 *
 *   node scripts/rollup-history.js
 *
 * Idempotent — each day is fully rewritten, so re-running is safe.
 */

require('../lib/loadenv');
const cfg = require('./../lib/config');
const db = require('./../lib/db');

async function main() {
  console.log('[rollup] seeding daily_* rollups from available history …');
  const t = Date.now();
  // maxDays high enough to cover all complete days we hold.
  const done = await db.rollupPendingDays(cfg.FLOW, cfg.STORAGE, 400);
  console.log(`[rollup] rolled up ${done.length} day(s)${done.length ? ` (${done[0]} … ${done[done.length - 1]})` : ''} in ${((Date.now() - t) / 1000).toFixed(1)}s`);
  await db.getPool().end();
}

main().catch((e) => {
  console.error('[rollup] failed:', e.message);
  process.exit(1);
});
