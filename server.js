'use strict';

/**
 * Ariadne web server — serves the map UI and read APIs backed by the store.
 *
 *   GET /api/ships    latest position per vessel in the live window (from DB)
 *   GET /api/config   bbox + live window for the front-end
 *   POST /api/ingest  protected one-off ingest trigger (X-Ingest-Token)
 *
 * The browser never talks to Marinesia: N visitors cost 0 upstream calls.
 */

require('./lib/loadenv');
const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('./lib/db');
const cfg = require('./lib/config');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, obj, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(obj));
}

async function handleShips(res) {
  try {
    const rows = await db.getLiveVessels(cfg.LIVE_WINDOW_MIN);
    sendJson(res, 200, { data: rows, count: rows.length });
  } catch (e) {
    console.error('[ships] query error:', e.message);
    sendJson(res, 503, { error: e.message });
  }
}

async function handleAllTracks(req, res) {
  const params = new URL(req.url, 'http://localhost').searchParams;
  let hours = parseInt(params.get('hours'), 10);
  if (!Number.isFinite(hours) || hours <= 0) hours = 12;
  hours = Math.min(hours, 72);
  try {
    const rows = await db.getAllTracks(cfg.LIVE_WINDOW_MIN, hours);
    const tracks = {};
    for (const r of rows) {
      (tracks[r.mmsi] ||= []).push({ lat: r.lat, lng: r.lng, ts: r.ts, sog: r.sog });
    }
    sendJson(res, 200, { hours, tracks });
  } catch (e) {
    console.error('[tracks] query error:', e.message);
    sendJson(res, 503, { error: e.message });
  }
}

function windowHours(req, def = 24, cap = 720) {
  const h = parseInt(new URL(req.url, 'http://localhost').searchParams.get('hours'), 10);
  if (!Number.isFinite(h) || h <= 0) return def;
  return Math.min(h, cap);
}

async function handleCrossings(req, res) {
  try {
    sendJson(res, 200, await db.getCordonSummary(windowHours(req), cfg.MAX_TRANSIT_HOURS));
  } catch (e) {
    console.error('[crossings] query error:', e.message);
    sendJson(res, 503, { error: e.message });
  }
}

async function handleFlow(req, res) {
  try {
    sendJson(res, 200, await db.getFlowSummary(windowHours(req), cfg.FLOW));
  } catch (e) {
    console.error('[flow] query error:', e.message);
    sendJson(res, 503, { error: e.message });
  }
}

async function handleActivity(req, res) {
  const params = new URL(req.url, 'http://localhost').searchParams;
  let days = parseInt(params.get('days'), 10);
  if (!Number.isFinite(days) || days <= 0) days = 14;
  days = Math.min(days, 60);
  try {
    sendJson(res, 200, await db.getActivity(cfg.LIVE_WINDOW_MIN, days));
  } catch (e) {
    console.error('[activity] query error:', e.message);
    sendJson(res, 503, { error: e.message });
  }
}

async function handleStorage(req, res) {
  try {
    sendJson(res, 200, await db.getFloatingStorage(cfg.LIVE_WINDOW_MIN, windowHours(req), cfg.STORAGE, cfg.FLOW));
  } catch (e) {
    console.error('[storage] query error:', e.message);
    sendJson(res, 503, { error: e.message });
  }
}

async function handleFlowSeries(req, res) {
  const params = new URL(req.url, 'http://localhost').searchParams;
  let days = parseInt(params.get('days'), 10);
  if (!Number.isFinite(days) || days <= 0) days = 14;
  days = Math.min(days, 60);
  const bucket = params.get('bucket') === 'hour' ? 'hour' : 'day';
  try {
    sendJson(res, 200, await db.getFlowSeries(days, bucket, cfg.FLOW));
  } catch (e) {
    console.error('[flowseries] query error:', e.message);
    sendJson(res, 503, { error: e.message });
  }
}

async function handleDestinations(req, res) {
  try {
    sendJson(res, 200, await db.getOutboundDestinations(cfg.LIVE_WINDOW_MIN));
  } catch (e) {
    console.error('[destinations] query error:', e.message);
    sendJson(res, 503, { error: e.message });
  }
}

async function handleIntegrity(req, res) {
  try {
    sendJson(res, 200, await db.getIntegritySummary(windowHours(req), cfg.INTEGRITY, cfg.LIVE_WINDOW_MIN));
  } catch (e) {
    console.error('[integrity] query error:', e.message);
    sendJson(res, 503, { error: e.message });
  }
}

async function handleTrack(req, res) {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const mmsi = parseInt(params.get('mmsi'), 10);
  if (!Number.isFinite(mmsi)) return sendJson(res, 400, { error: 'mmsi required' });
  let hours = parseInt(params.get('hours'), 10);
  if (!Number.isFinite(hours) || hours <= 0) hours = 24;
  hours = Math.min(hours, 168); // cap at 7 days
  try {
    const points = await db.getTrack(mmsi, hours);
    sendJson(res, 200, { mmsi, hours, points });
  } catch (e) {
    console.error('[track] query error:', e.message);
    sendJson(res, 503, { error: e.message });
  }
}

async function handleIngest(req, res) {
  const token = req.headers['x-ingest-token'];
  if (!process.env.INGEST_TOKEN || token !== process.env.INGEST_TOKEN) {
    return sendJson(res, 401, { error: 'unauthorized' });
  }
  try {
    const { runCycle } = require('./ingest');
    const result = await runCycle();
    sendJson(res, 200, { ok: true, ...result });
  } catch (e) {
    console.error('[ingest] trigger error:', e.message);
    sendJson(res, 502, { error: e.message });
  }
}

function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(__dirname, 'public', path.normalize(urlPath));
  if (!filePath.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
    });
    res.end(content);
  });
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/api/ships') return handleShips(res);
  if (url === '/api/track') return handleTrack(req, res);
  if (url === '/api/tracks') return handleAllTracks(req, res);
  if (url === '/api/crossings') return handleCrossings(req, res);
  if (url === '/api/flow') return handleFlow(req, res);
  if (url === '/api/activity') return handleActivity(req, res);
  if (url === '/api/flowseries') return handleFlowSeries(req, res);
  if (url === '/api/storage') return handleStorage(req, res);
  if (url === '/api/destinations') return handleDestinations(req, res);
  if (url === '/api/integrity') return handleIntegrity(req, res);
  if (url === '/api/config') {
    return sendJson(res, 200, {
      bbox: cfg.BBOX,
      tiles: cfg.TILES,
      liveWindowMin: cfg.LIVE_WINDOW_MIN,
      gates: cfg.GATES,
    });
  }
  if (url === '/api/ingest' && req.method === 'POST') return handleIngest(req, res);
  serveStatic(req, res);
});

server.listen(cfg.PORT, () => {
  console.log(`\n  Ariadne map running:  http://localhost:${cfg.PORT}\n`);

  // Local-dev convenience: run the ingest loop in-process. In production run
  // `npm run ingest` as a separate always-on worker instead.
  if (process.env.RUN_INGEST_IN_PROCESS === '1') {
    require('./ingest').loop().catch((e) => console.error('[ingest] loop error:', e));
  }
});
