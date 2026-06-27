# Project Ariadne — Strait of Hormuz Maritime Intelligence

A planning document. The live map is the first read-view on what is really a
**maritime-intelligence data asset** for the oil / crude / LNG / strategy desks.

---

## 1. North star

Build a continuously-updating picture of vessel activity in the Strait of Hormuz
(SoH), and a data foundation rich enough to support a layered analytics roadmap:

1. **Map** — live positions, trails, filters (done / in progress).
2. **Crossings** — count vessels transiting, by direction and type.
3. **Flow estimates** — barrels of crude/product crossing (capacity × laden state).
4. **Trade structure** — top destinations for exports, what's entering vs leaving.
5. **Anomaly / integrity layer** — ships going dark, shadow-fleet scoring,
   ship-to-ship (STS) transfers, identity spoofing.
6. **Macro layer (later)** — demand destruction, pricing impact.

> **Guiding principle:** the data is the product, not the map. Every analytics
> goal above is computed from a *complete, continuous, historical* time-series.
> **A minute of ingestion missed is unrecoverable.** Therefore continuous
> server-side ingestion starts as early as possible and never depends on a
> viewer having the page open.

---

## 2. Current state

- **Live map** (`server.js` + `public/`): Leaflet map of the SoH, rotated
  vessel markers, type filter, search box.
- **Ingestion today = none.** It's a live pull-through proxy: the browser polls
  `/api/ships`, the server makes one live Marinesia call (30s in-memory cache),
  returns a snapshot. No persistence, no history, viewer-dependent.
- This is fine as a demo but is **not** the shape the north star needs.

---

## 3. Confirmed constraints (these drive the design)

| Constraint | Value | Implication |
| --- | --- | --- |
| Marinesia rate limit | **5 calls / min** (7,200/day) | Generous; budget to *allocate*. |
| `/vessel/area` result cap | **2,000 vessels / call** | — |
| Current SoH vessels in box | **~577** | One call covers everything, 3.5× headroom. **No tiling needed.** |
| Live ingestion cost | **1 call / min** = 1,440/day | Leaves ~5,700/day for backfill + enrichment. |
| Vercel Hobby cron | **once per day only** | Cannot be the ingestion clock — use an external scheduler. |
| Free Postgres storage | ~0.5 GB | Fills in ~1–2 weeks of raw positions → need hot/cold split + rollups. |

**Endpoint in use:** `GET https://api.marinesia.com/api/v2/vessel/area`
params `lat_min, lat_max, long_min, long_max, key`.
Vessel fields: `name, imo, type, flag, mmsi, lat, lng, cog, sog, rot, hdt,
dest, eta, ts, status, a/b/c/d` (dims). **`draught`** is available on the v2
location endpoints — critical for barrel estimates.

SoH bounding box: lat **25.5–27.2 N**, long **54.5–57.6 E**.

---

## 4. Target architecture (the hybrid)

```
 continuous /vessel/area poll (1/min)          ← the spine, never viewer-dependent
   + lazy per-vessel historical backfill         ← once, on first sighting of a new MMSI
   → Postgres + PostGIS (hot, ~14–30 days)  →  R2 Parquet archive (cold, full history)
        ↑                       ↑
    map reads here        analytics jobs read here     (visitors cost 0 upstream calls)
```

Principles:

- **Decouple ingestion from viewers.** N visitors cost zero Marinesia calls; the
  map reads the store, not the live API. API key stays server-side.
- **Hot + cold storage.** Recent data in Postgres powers the map and live
  analytics; full history archived as date-partitioned Parquet for backtesting.
- **Lazy backfill.** When ingestion first sees an MMSI, fire one historical call
  (`/api/v2/vessel/location?mmsi=…`) for instant trails + transit context. Cost
  bounded to ~once per vessel, not per poll.

---

## 5. Data model (analytics-first)

**`vessels`** (dimension — one row per MMSI, upserted)
- `mmsi` (PK), `imo`, `name`, `type`, `flag`
- dims `a,b,c,d`, derived `length`, `beam`
- **enrichment** (later): `dwt`, `cargo_capacity_bbl`, `design_draught`,
  `build_year`, `owner`, `class_society`, `flag_history`
- `first_seen`, `last_seen`

**`positions`** (fact — the spine, append-only)
- `mmsi`, `ts`, `geom` (PostGIS point), `lat`, `lng`
- `sog`, `cog`, `hdt`, `rot`, `draught`, `status`, `dest`, `eta`
- index on `(mmsi, ts)`; spatial index on `geom`

**Derived / materialized (built per phase)**
- `transits` — one row per vessel crossing a tripwire line (ts, direction, type).
- `dark_events` — vessel stopped transmitting while plausibly still in area.
- `sts_candidates` — vessel pairs loitering alongside.
- daily rollups for map/analytics so queries don't rescan raw positions.

**Retention:** raw `positions` kept in Postgres ~14–30 days; everything streamed
to R2 Parquet (partitioned by date) for permanent history. Rollups kept long-term
in Postgres (small).

---

## 6. Ingestion service

- A small worker that every 60s: calls `/vessel/area`, upserts `vessels`,
  appends `positions`, triggers lazy backfill for new MMSIs, and writes the
  latest snapshot to a hot-read cache for the map.
- **Idempotent** on `(mmsi, ts)` so a re-fire never double-counts.
- **Observability:** log per-cycle vessel count and call latency; alert if the
  cycle is skipped (a skipped cycle = permanent data gap).
- **Reliability tiering:**
  - *Good:* external 1-min trigger (Cloudflare Workers cron, or cron-job.org)
    hitting a protected `/api/ingest` endpoint.
  - *Better (desk-grade):* a small always-on worker (Fly.io / Railway / cheap
    VPS) running its own loop, so ingestion doesn't depend on an external
    trigger firing reliably every minute.
- `/api/ingest` protected by a secret token so randoms can't burn quota.

---

## 7. Hosting

- **Frontend + read APIs:** Vercel Hobby (static `public/` + serverless funcs).
  Repoint `/api/ships` to read the hot store instead of calling Marinesia live.
- **Ingestion clock:** NOT Vercel cron (daily only). External 1-min scheduler,
  or an always-on worker (preferred for gap-free history).
- **Hot store:** Supabase (PostGIS built-in) or Neon. Free tier to start.
- **Cold store:** Cloudflare R2 (10 GB free) for the Parquet archive.

---

## 8. Phasing

- **Phase 0 — Foundation (do first).** Continuous 1-min ingestion → Postgres +
  PostGIS, with R2 archive + retention/rollups. Repoint the map to read the
  store. *Starts the irreplaceable history clock; everything sits on this.*
- **Phase 1 — Trails + backfill.** Trails are a free byproduct of stored
  positions; add lazy per-vessel historical backfill for instant context.
- **Phase 2 — Crossings.** Tripwire line(s) across the strait; count transits by
  direction and type. First real desk metric.
- **Phase 3 — Flow + trade structure.** Vessel enrichment (capacity, design
  draught) → draught-based barrel estimates; entering vs leaving; top
  destinations from `dest`/historical routes.
- **Phase 4+ — Integrity layer.** Dark-ship detection, STS candidates,
  shadow-fleet scoring, identity-spoofing flags.
- **Phase 5 — Macro.** Demand destruction, pricing-impact overlays.

---

## 9. Analytics design seeds (north star — informs schema *now*)

Each forces a foundation decision today:

- **Crossings** → define virtual tripwire line(s) across the strait (the
  traffic-separation scheme gives clean inbound/outbound lanes). A transit =
  consecutive-position segment intersecting the line (PostGIS `ST_Intersects`);
  direction from the crossing sign; dedup per vessel per transit. *Needs gap-free
  ~1-min sampling so a 15-kn tanker doesn't skip the line.*
- **Barrels crossing** → capacity × laden fraction. Laden proxy = reported
  **`draught` vs the vessel's design draught** → % laden → barrels. Direction
  separates laden exports (outbound) from ballast inbound. *Requires vessel
  enrichment with particulars.*
- **Dark ships** → detection of *absence*: a vessel transmitting and not
  plausibly exited stops appearing beyond a threshold. *Only works with
  continuous sampling — another reason ingestion can't be viewer-driven.*
- **STS transfers** → two vessels, ~0 SoG, within a few hundred metres, for
  hours, often at known anchorages → PostGIS proximity self-join over time
  windows.
- **Shadow fleet / spoofing** → AIS behavioral signals (flag-hopping,
  MMSI/IMO/name mismatch, impossible position jumps, loitering at STS zones) +
  external reference data (ownership, class, sanctions lists).

Throughline: **store everything, sample consistently, enrich vessels.**

---

## 10. Open items

- [ ] **ToS check:** confirm Marinesia permits storing + redistributing AIS data
      and derived analytics (this is heading toward a shared desk tool).
- [ ] Pick hot store: Supabase vs Neon.
- [ ] Pick ingestion host: external cron vs always-on worker (lean always-on for
      gap-free history).
- [ ] Source vessel-particulars dataset for enrichment (DWT, design draught,
      ownership) — needed for barrels + shadow-fleet phases.
- [ ] Define exact tripwire geometry for crossings (Phase 2).

---

## 11. Immediate next step

Phases 0–4 are shipped (see the README status section). The **integrity layer**
(Phase 4) now runs each ingest cycle: dark-ship detection (`dark_events`), STS
candidates (`sts_candidates`), and spoofing/identity flags, served by
`/api/integrity` and surfaced in the dashboard.

The Phase 4 heuristics have had a first hardening pass: dark detection is
scoped to tanker/cargo and excludes vessels that crossed a gate (transited out);
STS candidates require tanker involvement and honour tunable `ANCHORAGES`
exclusion zones; and **flag-hopping / IMO-swap** detection now runs off an
`identity_changes` log (a trigger captures flag/IMO mutations — names are
skipped as AIS spelling noise). Early real catches: a tanker reflagging
PAN→TGO→COM→ARE and several MMSIs broadcasting alternating IMO numbers.

Next: **Phase 5 — macro layer** (demand-destruction / pricing-impact overlays).
Further Phase 4 hardening as history accumulates — empirically seed the
anchorage polygons, reconcile never-resumed dark events against box-edge exits
(not just gate crossings), and damp flag-spelling flap before it can read as a
hop.

---

## 12. Distribution — weekly snapshot + email list

Turn the always-on data asset into a recurring **content engine** for the
personal brand (website / LinkedIn / Twitter), not just a live demo.

- **Weekly snapshot generator.** A scheduled job (weekly) that reads the existing
  `/api/flow` + `/api/integrity` + `/api/crossings` data and renders a short
  digest: Hormuz crude throughput and w/w delta, notable dark-ship / STS events,
  shadow-fleet catches, a chart. Output as both a postable blurb and an email.
- **Email signup on the site.** A capture form on the public map page → store
  addresses (Supabase table, or a provider like Buttondown/Resend audience).
  Owner is subscriber #1. Double opt-in + unsubscribe to stay clean.
- **Send.** Weekly job renders the snapshot and emails the list (Resend /
  Buttondown free tier). Same artifact seeds the social posts.
- *Sequencing:* ship **after** ingestion is hosted 24/7 (this section's data
  depends on a gap-free history clock already running).
