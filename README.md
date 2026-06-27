# Ariadne — Persian Gulf Maritime Intelligence

Continuous ingestion of AIS vessel data across the **Persian Gulf** into a
Postgres/PostGIS store, with a live Leaflet map as the first read-view. The Gulf
exceeds the 2000-vessel `/vessel/area` cap, so the AOI is **tiled** (`TILES` in
`lib/config.js`): the Strait of Hormuz cordon tile is polled every cycle, the
rest round-robin within the 5-calls/min budget. See [`PLAN.md`](./PLAN.md).

```
 ingest worker (1/min) ── Marinesia /vessel/area × N tiles ──┐
   (hormuz every cycle + rotating tiles)                     ▼
                                        Postgres + PostGIS (vessels, positions)
                                                    ▲
 browser ── /api/ships (latest per vessel) ── web server (server.js)
```

The browser never talks to Marinesia — N visitors cost **zero** upstream API
calls, and the key stays server-side.

## Prerequisites

- Node 18+
- A Postgres database with **PostGIS** (free tier works):
  - **Supabase** (recommended — PostGIS preinstalled) or **Neon**.

## Setup

```bash
npm install
cp .env.example .env          # then fill in MARINESIA_API_KEY and DATABASE_URL
npm run migrate               # applies schema.sql (tables, PostGIS, indexes)
```

> The migration is idempotent (`CREATE … IF NOT EXISTS`), so re-run `npm run
> migrate` after pulling new phases — Phase 4 adds the `dark_events` and
> `sts_candidates` tables, for example.

> Supabase note: PostGIS is available but may need enabling once via
> `CREATE EXTENSION postgis;` (the migration runs this for you). Use the pooled
> ("Transaction") connection string for serverless deploys.

## Run (local)

Two processes — the always-on ingest worker, and the web server:

```bash
npm run ingest      # terminal 1: continuous ingestion (gap-free history)
npm start           # terminal 2: web server -> http://localhost:3000
```

Or, for convenience in local dev, run both in one process:

```bash
npm run dev         # web server + in-process ingest loop
```

## Verify

```bash
npm run selftest    # offline tests of the transform + SQL builders (no DB/API)
```

Trigger a one-off ingest over HTTP (needs `INGEST_TOKEN` set):

```bash
curl -X POST -H "X-Ingest-Token: $INGEST_TOKEN" http://localhost:3000/api/ingest
```

## Configuration (env)

| Var                        | Default                | Meaning                                       |
| -------------------------- | ---------------------- | --------------------------------------------- |
| `MARINESIA_API_KEY`        | —                      | Premium key (ingest only).                    |
| `DATABASE_URL`             | —                      | Postgres connection string (PostGIS).         |
| `PORT`                     | `3000`                 | Web server port.                              |
| `INGEST_INTERVAL_MS`       | `60000`                | Ingestion cadence (rate limit is 5/min).      |
| `TILES_PER_CYCLE`          | `3`                    | Rotating (non-priority) tiles fetched per cycle; priority tiles every cycle. |
| `BACKFILL_PER_CYCLE`       | `1`                    | Vessels to backfill history for per cycle (rest of the call budget). |
| `MARINESIA_MAX_PER_MIN`    | `5`                    | Global rolling cap on Marinesia calls/min (matches the plan tier). |
| `LIVE_WINDOW_MIN`          | `60`                   | A vessel counts as "present" if seen within.  |
| `POSITIONS_RETENTION_DAYS` | `30`                   | Raw positions older than this are pruned.     |
| `INGEST_TOKEN`             | —                      | Secret protecting `POST /api/ingest`.         |
| `RUN_INGEST_IN_PROCESS`    | `0`                    | `1` runs the ingest loop inside the web server (dev). |
| `DARK_MIN_HOURS`           | `1`                    | Quiet at least this long before a vessel counts as dark. |
| `DARK_MAX_HOURS`           | `24`                   | Quiet longer than this ⇒ treated as departed, not dark. |

Other integrity thresholds (STS distance/duration, jump speed/distance, etc.)
live in the `INTEGRITY` block of `lib/config.js`.

## Layout

| Path             | Role                                                      |
| ---------------- | -------------------------------------------------------- |
| `ingest.js`      | Continuous ingestion worker (the spine).                |
| `server.js`      | Web server + read APIs (`/api/ships`, `/api/crossings`, `/api/flow`, `/api/integrity`, `/api/config`). |
| `lib/marinesia.js` | API client + payload normalization.                   |
| `lib/db.js`      | Postgres access layer + SQL builders.                   |
| `lib/integrity.js` | Pure integrity logic (IMO/MMSI validation, jumps, shadow-fleet score). |
| `lib/sanctions.js` | Pure watchlist loader + IMO/MMSI cross-matcher.       |
| `data/sanctions.json` | Operator-maintained designated-vessel watchlist (ships empty). |
| `schema.sql`     | Tables, PostGIS geometry, indexes.                      |
| `migrate.js`     | Applies `schema.sql`.                                   |
| `public/`        | Leaflet map front-end.                                  |
| `selftest.js`    | Offline unit tests.                                     |

## Status: Phase 4

Done:
- **Phase 0** — continuous ingestion → Postgres/PostGIS, map reads the store,
  retention pruning, three colour-by views (type / report-age / activity).
- **Phase 1** — vessel **trails** (click a vessel or its trail to open the card)
  via `GET /api/track?mmsi=&hours=`, plus **lazy historical backfill**.
- **Phase 1.5** — map clarity: chart-symbol key, click-to-identify
  (OpenSeaMap/Overpass), layer toggles.
- **Phase 2** — **two-gate cordon** (`GATES` in `lib/config.js`): gate W (Gulf
  side) and gate E (Oman side). Each ingest cycle detects gate crossings
  (`gate_crossings`) and pairs them into **completed passages** (`passages`) —
  crossing both gates in order, same direction, within `MAX_TRANSIT_HOURS`.
  This is robust to loitering / U-turns (which never hit both gates) and yields
  inter-gate transit time. `GET /api/crossings?hours=` returns completed
  passages by direction (outbound = exports) + median transit, gross crossings,
  and anomaly buckets (U-turns, slow, incomplete). Both gates are drawn on the
  map — eyeball them against the TSS lanes and tune the endpoints.

- **Phase 3** — **estimated crude flow**: Marinesia has no DWT, so capacity is
  estimated from AIS length (`DWT ≈ refDwt·(L/refLen)³`, then bbl) and laden
  state from draught (fallback by direction). Factors live in `FLOW`
  (`lib/config.js`); `enrichVessels` fills capacity each cycle; see
  `GET /api/flow?hours=`. Outputs are clearly-labelled estimates.
- **Phase 4** — **integrity layer** (`lib/integrity.js` + `INTEGRITY` in
  `lib/config.js`). Three signals, computed each ingest cycle off the same fresh
  fixes and served by `GET /api/integrity?hours=`:
  - **Dark ships** (`dark_events`) — a tanker/cargo that goes quiet while still
    in the interior of the box, was under way, and did **not** cross a cordon
    gate (so it didn't simply transit out). Detection of *absence* — only
    possible because ingestion is gap-free. Each event closes when the MMSI
    transmits again, recording the gap and how far it jumped (a far
    re-appearance is flagged `jumped`).
  - **STS candidates** (`sts_candidates`) — two slow vessels held within a few
    hundred metres (PostGIS `ST_DWithin`), tracked as episodes across cycles and
    surfaced once sustained past `stsMinDurMin`. Restricted to **tanker-involved**
    pairs (the shadow-fleet signal; also strips tug/passenger harbour clusters),
    with tunable `ANCHORAGES` exclusion zones for routine waiting areas.
  - **Spoofing / identity** — IMO check-digit + MMSI MID-range validation over
    the vessels on station; **impossible position jumps** (implied speed between
    consecutive fixes above `jumpMaxSpeedKn`); and **flag-hopping / IMO-swap**
    detection via an `identity_changes` log (a trigger records flag/IMO
    mutations — a permanent IMO changing is near-definitive identity fraud).
- **Phase 4.5** — **sanctions exposure** (second analytics row), served in the
  same `GET /api/integrity?hours=` payload (`watchlist` + `shadowFleet` blocks):
  - **Sanctions watchlist** — live vessels matched against an operator-maintained
    designated-vessel list (`data/sanctions.json`, IMO first then MMSI; re-read
    each request, so edits need no restart). Ships **empty** — populate from
    authoritative designations (OFAC SDN / OFSI / EU). A match is an exposure
    signal, not an adjudication.
  - **Shadow-fleet watch** — every flagged hull scored 0–1 by fusing the
    integrity tells it fired (watchlist · IMO-swap · reflag · bad/​no-IMO · dark ·
    jump · STS) via a *noisy-OR* combiner (`shadowFleetScore` in
    `lib/integrity.js`; weights are a tunable analyst prior). Ranked worst-first,
    each row showing its score bar + firing reasons.
- **UI** — terminal-style dashboard: map on top, analytics cells below.
  Row 1: fleet on station, cordon passages, estimated crude flow, anomalies,
  integrity layer. Row 2: sanctions watchlist + shadow-fleet watch. Click any
  signal row to pan the map to the vessel.

Phase 4 adds the `dark_events`, `sts_candidates` and `identity_changes` tables
(plus the identity-change trigger) — re-run `npm run migrate`. Signals are
deliberately **heuristic watchlists, not adjudications**; thresholds are tunable
in `lib/config.js`. **Next:** Phase 5 (macro layer — demand destruction,
pricing-impact overlays). See [`PLAN.md`](./PLAN.md).
