'use strict';

/** Minimal .env loader (no dependency). Loads ./.env if present; does not
 *  override variables already set in the real environment. */

const fs = require('fs');
const path = require('path');

const envPath = path.join(process.cwd(), '.env');
try {
  const text = fs.readFileSync(envPath, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
} catch (_) {
  // no .env file — rely on real environment
}
