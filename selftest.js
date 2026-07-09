'use strict';

/** Offline tests for the pure transform + SQL-builder logic (no DB / no API). */

const assert = require('assert');
const { extractVessels, normalizeVessel, buildSnapshot, buildTrack, parseTs } = require('./lib/marinesia');
const { buildVesselUpsert, buildPositionInsert } = require('./lib/db');
const integrity = require('./lib/integrity');
const sanctions = require('./lib/sanctions');

let passed = 0;
const ok = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

// A representative /vessel/area record (fields per the OpenAPI spec).
const sample = {
  name: 'FRONT ALTAIR',
  imo: 9249882,
  type: 'Tanker',
  flag: 'Marshall Islands',
  a: 250, b: 30, c: 20, d: 25,
  mmsi: 538001234,
  lat: 26.5667,
  lng: 56.25,
  cog: 118.4,
  sog: 12.3,
  rot: 0,
  hdt: 119,
  dest: 'NINGBO',
  eta: '2026-07-02T10:00:00Z',
  ts: '2026-06-20T08:30:00Z',
  status: 0,
};

ok('extractVessels: bare array', () => {
  assert.deepStrictEqual(extractVessels([sample]).length, 1);
});

ok('extractVessels: { data: [...] } envelope', () => {
  assert.strictEqual(extractVessels({ data: [sample, sample] }).length, 2);
});

ok('extractVessels: unknown shape -> []', () => {
  assert.deepStrictEqual(extractVessels({ nope: true }), []);
  assert.deepStrictEqual(extractVessels(null), []);
});

ok('normalizeVessel: splits vessel + position correctly', () => {
  const n = normalizeVessel(sample);
  assert.strictEqual(n.vessel.mmsi, 538001234);
  assert.strictEqual(n.vessel.imo, 9249882);
  assert.strictEqual(n.vessel.name, 'FRONT ALTAIR');
  assert.strictEqual(n.vessel.a, 250);
  assert.strictEqual(n.vessel.last_seen, '2026-06-20T08:30:00.000Z');
  assert.strictEqual(n.position.lat, 26.5667);
  assert.strictEqual(n.position.lng, 56.25);
  assert.strictEqual(n.position.sog, 12.3);
  assert.strictEqual(n.position.status, 0);
  assert.strictEqual(n.position.ts, '2026-06-20T08:30:00.000Z');
  assert.strictEqual(n.position.draught, null); // not in area feed
});

ok('normalizeVessel: coerces numeric strings', () => {
  const n = normalizeVessel({ mmsi: '12345', lat: '1.5', lng: '2.5', sog: '9.0' });
  assert.strictEqual(n.vessel.mmsi, 12345);
  assert.strictEqual(n.position.lat, 1.5);
  assert.strictEqual(n.position.sog, 9);
});

ok('normalizeVessel: drops records missing mmsi or coords', () => {
  assert.strictEqual(normalizeVessel({ lat: 1, lng: 2 }), null);
  assert.strictEqual(normalizeVessel({ mmsi: 1, lng: 2 }), null);
  assert.strictEqual(normalizeVessel(null), null);
});

ok('normalizeVessel: falls back to provided ts when missing/invalid', () => {
  const fb = new Date('2026-01-01T00:00:00Z');
  const n = normalizeVessel({ mmsi: 1, lat: 1, lng: 2 }, fb);
  assert.strictEqual(n.position.ts, fb.toISOString());
});

ok('parseTs: handles the formats AIS feeds throw at us', () => {
  const fb = new Date('2026-06-20T12:00:00Z');
  // ISO with zone
  assert.strictEqual(parseTs('2026-06-20T08:30:00Z', fb).toISOString(), '2026-06-20T08:30:00.000Z');
  // timezone-naive -> assumed UTC (not local)
  assert.strictEqual(parseTs('2026-06-20 08:30:00', fb).toISOString(), '2026-06-20T08:30:00.000Z');
  // epoch seconds
  assert.strictEqual(parseTs(1750408200, fb).toISOString(), '2025-06-20T08:30:00.000Z');
  assert.strictEqual(parseTs('1750408200', fb).toISOString(), '2025-06-20T08:30:00.000Z');
  // epoch milliseconds
  assert.strictEqual(parseTs(1750408200000, fb).toISOString(), '2025-06-20T08:30:00.000Z');
  // garbage / empty -> fallback
  assert.strictEqual(parseTs('not-a-date', fb).toISOString(), fb.toISOString());
  assert.strictEqual(parseTs('', fb).toISOString(), fb.toISOString());
  assert.strictEqual(parseTs(0, fb).toISOString(), fb.toISOString()); // implausible year
});

ok('buildSnapshot: dedupes MMSI and stamps last_seen = ingestion time', () => {
  // Same MMSI twice (different ts) + a different vessel.
  const older = { ...sample, ts: '2026-06-20T08:00:00Z' };
  const newer = { ...sample, ts: '2026-06-20T08:30:00Z', dest: 'FUJAIRAH' };
  const other = { ...sample, mmsi: 111, ts: '2026-06-20T08:30:00Z' };
  const ingest = new Date('2026-06-20T10:31:00Z');
  const snap = buildSnapshot([older, newer, other], ingest);
  assert.strictEqual(snap.vessels.length, 2);                 // one row per MMSI
  const v = snap.vessels.find((x) => x.mmsi === sample.mmsi);
  assert.strictEqual(v.last_seen, ingest.toISOString());      // presence = ingest time
  // Distinct (mmsi, ts) positions are all retained for history.
  assert.strictEqual(snap.positions.length, 3);
});

ok('buildSnapshot: collapses duplicate (mmsi, ts) positions', () => {
  const snap = buildSnapshot([sample, { ...sample }]); // identical mmsi+ts
  assert.strictEqual(snap.vessels.length, 1);
  assert.strictEqual(snap.positions.length, 1);
});

ok('buildTrack: forces mmsi, dedupes by ts, builds positions', () => {
  // History records (no mmsi field, queried by mmsi); one duplicate ts.
  const hist = [
    { lat: 26.5, lng: 56.2, ts: '2026-06-20T07:00:00Z', sog: 11 },
    { lat: 26.6, lng: 56.3, ts: '2026-06-20T07:10:00Z', sog: 12 },
    { lat: 26.6, lng: 56.3, ts: '2026-06-20T07:10:00Z', sog: 12 }, // dup ts
    { lng: 56.4, ts: '2026-06-20T07:20:00Z' }, // missing lat -> dropped
  ];
  const pts = buildTrack(hist, 538001234);
  assert.strictEqual(pts.length, 2);
  pts.forEach((p) => assert.strictEqual(p.mmsi, 538001234));
  assert.strictEqual(pts[0].ts, '2026-06-20T07:00:00.000Z');
});

ok('buildVesselUpsert: column/value alignment', () => {
  const n1 = normalizeVessel(sample).vessel;
  const n2 = normalizeVessel({ ...sample, mmsi: 999, name: 'OTHER' }).vessel;
  const { text, values } = buildVesselUpsert([n1, n2]);
  assert.strictEqual(values.length, 21);            // 10 identity/meta + 11 cur_* columns
  values.forEach((col) => assert.strictEqual(col.length, 2)); // 2 rows
  assert.deepStrictEqual(values[0], [538001234, 999]); // mmsi column
  assert.deepStrictEqual(values[2], ['FRONT ALTAIR', 'OTHER']); // name column
  for (let i = 1; i <= 21; i++) assert.ok(text.includes(`$${i}::`));
});

ok('buildPositionInsert: column/value alignment', () => {
  const p = normalizeVessel(sample).position;
  const { text, values } = buildPositionInsert([p, p]);
  assert.strictEqual(values.length, 12);            // 12 columns
  values.forEach((col) => assert.strictEqual(col.length, 2));
  assert.deepStrictEqual(values[0], [538001234, 538001234]); // mmsi
  assert.deepStrictEqual(values[2], [26.5667, 26.5667]);     // lat
  for (let i = 1; i <= 12; i++) assert.ok(text.includes(`$${i}::`));
});

// --- Integrity layer (Phase 4) ----------------------------------------------

const IG = {
  jumpMaxSpeedKn: 60, jumpMinDistKm: 5, identityMinLengthM: 100,
};

ok('imoChecksumValid: accepts valid IMO, rejects bad ones', () => {
  assert.strictEqual(integrity.imoChecksumValid(9074729), true);  // valid IMO
  assert.strictEqual(integrity.imoChecksumValid('9319466'), true); // valid (string)
  assert.strictEqual(integrity.imoChecksumValid(9074728), false); // wrong check digit
  assert.strictEqual(integrity.imoChecksumValid(12345), false);   // too short
  assert.strictEqual(integrity.imoChecksumValid(null), false);
  assert.strictEqual(integrity.imoChecksumValid('abcdefg'), false);
});

ok('mmsiPlausible: ship-station MID range only', () => {
  assert.strictEqual(integrity.mmsiPlausible(538001234), true);  // MID 538, ok
  assert.strictEqual(integrity.mmsiPlausible(201000000), true);  // lower bound
  assert.strictEqual(integrity.mmsiPlausible(111000001), false); // SAR aircraft
  assert.strictEqual(integrity.mmsiPlausible(8000000001), false); // 10 digits
  assert.strictEqual(integrity.mmsiPlausible(99123456), false);  // 8 digits
  assert.strictEqual(integrity.mmsiPlausible(992011234), false); // MID 992 (AtoN)
});

ok('identityFlags: missing IMO only matters on big tankers', () => {
  // Big tanker, no IMO -> flagged.
  assert.deepStrictEqual(
    integrity.identityFlags({ mmsi: 538001234, imo: null, type: 'Tanker', length: 250 }, IG),
    ['no-imo']
  );
  // Small craft without IMO -> not flagged.
  assert.deepStrictEqual(
    integrity.identityFlags({ mmsi: 538001234, imo: null, type: 'Tug', length: 20 }, IG),
    []
  );
  // Bad IMO checksum -> flagged regardless of size.
  assert.deepStrictEqual(
    integrity.identityFlags({ mmsi: 538001234, imo: 9074728, type: 'Tanker', length: 250 }, IG),
    ['bad-imo']
  );
  // Odd MMSI rides alongside a clean IMO (9074729 is a valid checksum).
  assert.deepStrictEqual(
    integrity.identityFlags({ mmsi: 111000001, imo: 9074729, type: 'Tanker', length: 250 }, IG),
    ['odd-mmsi']
  );
});

ok('impliedSpeedKn: distance over time, guards bad intervals', () => {
  const a = { lat: 26.0, lng: 56.0, ts: '2026-06-20T00:00:00Z' };
  const b = { lat: 26.0, lng: 56.0, ts: '2026-06-20T00:00:00Z' };
  assert.strictEqual(integrity.impliedSpeedKn(a, b), null); // zero interval
  // 1 degree of latitude = 60 nm; over 1 hour = 60 kn.
  const c = { lat: 27.0, lng: 56.0, ts: '2026-06-20T01:00:00Z' };
  const kn = integrity.impliedSpeedKn(a, c);
  assert.ok(Math.abs(kn - 60) < 0.5, `expected ~60 kn, got ${kn}`);
});

ok('isImpossibleJump: needs both real distance and absurd speed', () => {
  const a = { lat: 26.0, lng: 56.0, ts: '2026-06-20T00:00:00Z' };
  // 1° lat in 1 min -> 60 nm in 1/60 h = 3600 kn, well over the gate -> jump.
  const fast = { lat: 27.0, lng: 56.0, ts: '2026-06-20T00:01:00Z' };
  assert.strictEqual(integrity.isImpossibleJump(a, fast, IG), true);
  // Same 1° but over 2 h -> 30 kn: real distance but plausible speed -> no.
  const slow = { lat: 27.0, lng: 56.0, ts: '2026-06-20T02:00:00Z' };
  assert.strictEqual(integrity.isImpossibleJump(a, slow, IG), false);
  // Tiny jitter at absurd speed but under the distance floor -> no.
  const jitter = { lat: 26.001, lng: 56.0, ts: '2026-06-20T00:00:01Z' };
  assert.strictEqual(integrity.isImpossibleJump(a, jitter, IG), false);
});

ok('inInterior: true only when clear of every bbox edge', () => {
  const bbox = { lat_min: 25.5, lat_max: 27.2, long_min: 54.5, long_max: 57.6 };
  assert.strictEqual(integrity.inInterior(26.3, 56.0, bbox, 0.05), true);
  assert.strictEqual(integrity.inInterior(27.18, 56.0, bbox, 0.05), false); // near N edge
  assert.strictEqual(integrity.inInterior(26.3, 54.52, bbox, 0.05), false); // near W edge
});

ok('shadowFleetScore: noisy-OR accumulates and saturates', () => {
  // No tells -> 0.
  assert.strictEqual(integrity.shadowFleetScore({}), 0);
  // A single tell returns its own weight.
  assert.strictEqual(integrity.shadowFleetScore({ dark: true }), 0.3);
  // Independent weak tells accumulate but never exceed 1.
  const two = integrity.shadowFleetScore({ dark: true, sts: true }); // 1-(.7)(.8)=.44
  assert.ok(Math.abs(two - 0.44) < 1e-9, `expected 0.44, got ${two}`);
  assert.ok(two > 0.3 && two < 1);
  // A watchlist match dominates.
  assert.ok(integrity.shadowFleetScore({ watchlist: true }) >= 0.97);
  // Unknown keys are ignored (no weight).
  assert.strictEqual(integrity.shadowFleetScore({ nope: true }), 0);
});

ok('riskReasons: fired tells, strongest weight first', () => {
  assert.deepStrictEqual(
    integrity.riskReasons({ sts: true, watchlist: true, dark: true }),
    ['sanctioned', 'dark', 'STS']
  );
  assert.deepStrictEqual(integrity.riskReasons({}), []);
});

ok('sanctions.normalizeEntry: coerces keys to trimmed strings', () => {
  const e = sanctions.normalizeEntry({ imo: 9249882, mmsi: ' 538001234 ', name: 'X' });
  assert.strictEqual(e.imo, '9249882');
  assert.strictEqual(e.mmsi, '538001234');
  assert.strictEqual(e.name, 'X');
  // Blank/absent keys normalise to null.
  const blank = sanctions.normalizeEntry({ imo: '', name: 'Y' });
  assert.strictEqual(blank.imo, null);
  assert.strictEqual(blank.mmsi, null);
});

ok('sanctions.matchVessel: IMO wins, MMSI falls back, numeric/string agnostic', () => {
  const idx = sanctions.indexWatchlist([
    sanctions.normalizeEntry({ imo: 9249882, name: 'DESIGNATED', program: 'OFAC SDN' }),
    sanctions.normalizeEntry({ mmsi: 538009999, name: 'BY-MMSI' }),
  ]);
  assert.strictEqual(idx.size, 2);
  // Match by IMO (numbers vs the string-keyed index).
  const a = sanctions.matchVessel({ imo: 9249882, mmsi: 111 }, idx);
  assert.strictEqual(a.on, 'imo');
  assert.strictEqual(a.entry.name, 'DESIGNATED');
  // Match by MMSI when IMO is absent/unknown.
  const b = sanctions.matchVessel({ imo: null, mmsi: '538009999' }, idx);
  assert.strictEqual(b.on, 'mmsi');
  // No match -> null.
  assert.strictEqual(sanctions.matchVessel({ imo: 1, mmsi: 2 }, idx), null);
});

ok('sanctions.loadWatchlist: shipped file is valid and empty by default', () => {
  // The repo ships data/sanctions.json with no live entries; underscore-prefixed
  // schema/example keys must not leak in as matchable entries.
  assert.deepStrictEqual(sanctions.loadWatchlist(), []);
  // Missing file -> empty, no throw.
  assert.deepStrictEqual(sanctions.loadWatchlist('/no/such/file.json'), []);
});

// --- Vessel size / cargo estimation (the barrel maths) ----------------------

const estimate = require('./lib/estimate');
const FLOW = {
  refLen: 330, refDwt: 300000, cargoFraction: 0.93, bblPerTonne: 7.33,
  draughtCoef: 0.066, ballastFraction: 0.5, minLengthM: 100,
};

ok('estimate.vesselClass: length → conventional tanker class', () => {
  assert.strictEqual(estimate.vesselClass(330), 'VLCC');
  assert.strictEqual(estimate.vesselClass(380), 'ULCC');
  assert.strictEqual(estimate.vesselClass(275), 'Suezmax');
  assert.strictEqual(estimate.vesselClass(250), 'Aframax/LR2');
  assert.strictEqual(estimate.vesselClass(183), 'MR');
  assert.strictEqual(estimate.vesselClass(120), 'Handy');
  assert.strictEqual(estimate.vesselClass(0), null);
  assert.strictEqual(estimate.vesselClass(null), null);
});

ok('estimate.estimateDwt: cube law anchors the VLCC and clamps extremes', () => {
  assert.strictEqual(estimate.estimateDwt(330, FLOW), 300000);      // reference exact
  assert.strictEqual(estimate.estimateDwt(90, FLOW), null);         // below min length
  // Cube law within band: a Suezmax (~275 m) lands ~170k DWT.
  const sxm = estimate.estimateDwt(275, FLOW);
  assert.ok(sxm > 150000 && sxm < 200000, `suezmax dwt ${sxm}`);
  // A mislabelled 450 m hull is clamped to the ULCC ceiling, not ~760k.
  assert.strictEqual(estimate.estimateDwt(450, FLOW), estimate.DWT_MAX);
});

ok('estimate.capacityBbl: VLCC ≈ 2.0M bbl, unknown length → null', () => {
  const vlcc = estimate.capacityBbl(330, FLOW);
  assert.ok(vlcc > 1.9e6 && vlcc < 2.1e6, `vlcc bbl ${vlcc}`);
  assert.strictEqual(estimate.capacityBbl(50, FLOW), null);
});

ok('estimate.ladenFraction: clamps to [0,1], null when unmeasured', () => {
  const design = estimate.designDraught(330, FLOW);           // ~21.8 m
  assert.strictEqual(estimate.ladenFraction(design, design, 0.5), 1);          // full
  assert.strictEqual(estimate.ladenFraction(0.5 * design, design, 0.5), 0);    // ballast
  const half = estimate.ladenFraction(0.75 * design, design, 0.5);
  assert.ok(Math.abs(half - 0.5) < 1e-9, `half laden ${half}`);
  assert.strictEqual(estimate.ladenFraction(design * 2, design, 0.5), 1);      // over-clamped
  assert.strictEqual(estimate.ladenFraction(null, design, 0.5), null);         // no draught
  assert.strictEqual(estimate.ladenFraction(10, 0, 0.5), null);                // no design
});

ok('estimate.impliedBarrels: unknowns never count as zero', () => {
  assert.strictEqual(estimate.impliedBarrels(2.0e6, 0.5), 1.0e6);
  assert.strictEqual(estimate.impliedBarrels(null, 0.5), null);
  assert.strictEqual(estimate.impliedBarrels(2.0e6, null), null);
});

console.log(`\n${passed} tests passed.\n`);
