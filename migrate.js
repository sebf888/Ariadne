'use strict';

/** Applies schema.sql to the database in DATABASE_URL. */

require('./lib/loadenv');
const fs = require('fs');
const path = require('path');
const db = require('./lib/db');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  console.log('[migrate] applying schema.sql …');
  await db.query(sql);
  console.log('[migrate] done.');
  await db.getPool().end();
}

main().catch((e) => {
  console.error('[migrate] failed:', e.message);
  process.exit(1);
});
