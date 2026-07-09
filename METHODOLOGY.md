# Ariadne — Methodology & Data Integrity

How every number Ariadne reports is derived, what it assumes, and how to read it.
The guiding principle: **the AIS feed gives position, identity and hull
dimensions — never cargo — so all volume figures are transparent estimates,
labelled as such, with their assumptions and coverage exposed alongside them.**

All maths lives in one tested place (`lib/estimate.js`, pinned by `selftest.js`);
the SQL rollups mirror it. Tunable constants are in `lib/config.js`.

---

## 1. Data source

- **Feed:** Marinesia AIS `vessel/area` snapshots, polled per geographic tile.
- **Coverage area:** the Gulf, tiled (`config.TILES`); the Strait of Hormuz tile
  is polled every cycle, others rotate.
- **Effective temporal resolution:** positions are keyed by AIS *transmit* time
  and de-duplicated, so the resolution is the vessel's own reporting cadence —
  empirically **~6–7 distinct fixes per tanker per day** (≈3–4 h). Gate-crossing
  detection interpolates across consecutive fixes, so it is robust to this
  sparsity; floating-storage classification is more sensitive (see §5).
- **Presence vs. position:** a vessel is "present" by ingestion time
  (`last_seen`); its plotted position may be an older AIS report (`cur_ts`).

---

## 2. Vessel capacity (deadweight → barrels)

The feed carries no deadweight (DWT). We infer it from overall length `L`
(from AIS dimensions `a+b`), anchored on a reference VLCC:

```
DWT(t) ≈ refDwt · (L / refLen)³            refDwt = 300,000 t, refLen = 330 m
       clamped to [3,000, 650,000] t
capacity(bbl) ≈ DWT · cargoFraction · bblPerTonne     cargoFraction = 0.93, bblPerTonne = 7.33
```

- **Cube law:** deadweight scales with displaced volume (~`L³` for
  geometrically similar hulls). Anchoring on a known class keeps the VLCC band
  exact.
- **cargoFraction 0.93:** cargo as a share of DWT (remainder: bunkers, stores,
  constant weights). **bblPerTonne 7.33:** standard barrels/tonne for a typical
  ~33° API crude.
- **Clamps** guard against mislabelled hulls (e.g. a 400 m container ship tagged
  "tanker") inflating a total; 650k t is just above the historical ULCC ceiling
  (Seawise Giant, 564k t). Hulls > 450 m or < 100 m are not priced.

**Validation (live data, ~500 tankers with estimates):** the class distribution
lands where it should — VLCC band (~330 m) → ~2.0M bbl, Suezmax (~275 m) →
~1.1–1.2M bbl, MR (~180 m) → ~0.28M bbl. Median ≈ 350k bbl for the mixed Gulf
fleet. Errors are within ~±20% across the ladder; below VLCC the cube law reads
slightly low. Coverage is ~100% of tankers ≥ 100 m (only hulls with no AIS
dimensions are unpriced).

Size-class labels (`vesselClass`) use conventional length bands for
breakdowns/interpretation only — never for the barrel maths, which is continuous.

---

## 3. Laden state (how full)

Load fraction is inferred from self-reported draught vs. estimated design
draught (`designDraught = draughtCoef · L`, `draughtCoef = 0.066`):

```
ladenFraction = clamp01( (draught − ballastFraction·design) / ((1 − ballastFraction)·design) )
                                                             ballastFraction = 0.5
```

0 = ballast (empty), 1 = fully laden; linear between an assumed ballast draught
(half of design) and full design draught.

- **When draught is reported** (the preferred, higher-confidence path), load is
  measured, not assumed. Live data shows draught present on ~100% of *detected
  transits* — every barrel figure discloses `ladenFromDraught` vs. fallback.
- **When draught is missing**, we fall back to a direction assumption —
  outbound `0.95` (laden export leaving the Gulf), inbound `0.10` (ballast
  return) — and say so in the output. Self-reported draught is a known-noisy AIS
  field (crews often leave it static), so even the measured path is an estimate.

Unknown capacity or unknown load **never counts as zero** — it is excluded and
reflected in the coverage counts, so estimates aren't silently deflated.

---

## 4. Barrel flow (Strait throughput)

A **passage** is a completed transit: a vessel crossing **both** cordon gates in
the **same direction** within `MAX_TRANSIT_HOURS`. Gates are lines across the
strait; a crossing is detected where the segment between two consecutive fixes
intersects a gate line (`ST_Crosses`), with direction from the sign of the
longitude change (west = inbound to the Gulf, east = outbound). Loiter/U-turns
never hit both gates and are excluded by construction.

Flow = Σ `capacity · ladenFraction` over tanker passages in the window, split by
direction.

### How to read it — capture is partial (the key caveat)

A transit is counted **only when the vessel crosses both gates while under AIS
observation.** Sampling gaps, AIS-dark segments, and vessels skirting the gates
mean **capture is a fraction of true traffic.** Measured against the EIA
reference of ~20 MMbbl/d of crude through Hormuz, detected outbound flow is on
the order of **~10–15%** of the total.

**Therefore the absolute barrel level understates throughput and must be read as
a relative index / trend, not an absolute total.** Every flow response carries
`basis: "detected"`, a `note` stating this, and per-direction coverage
(`tankerPassages`, `ladenFromDraught`, `capacityKnown`) so the reader can weight
it. Day-over-day and year-over-year *changes* in the index are the signal; the
headline level is not a claim about total oil moved.

---

## 5. Floating storage (oil on water)

A tanker is "parked" over a window when it: has **≥ `minFixes` (3)** fixes,
spanned **≥ `minHours` (6)**, stayed within a **`maxSpanKm` (5 km)** bounding
box, and averaged **≤ `maxAvgSog` (0.7 kn)**. Laden + parked ≈ crude held at sea;
clusters of parked tankers ≈ an anchorage queue.

- Implied stored barrels use the same capacity × laden model (§2–3); vessels
  without draught contribute to the **count** but not the **barrels** (disclosed
  via `ladenCount` vs `parked`).
- The `minFixes` guard stops a vessel seen only once or twice — where average
  speed and span are meaningless — from being mislabelled as parked.
- **Dwell** (how long crude has been sitting) is built from the persisted daily
  snapshots: consecutive days a vessel is in storage give the **7 / 12 / 20-day**
  dwell buckets (`/api/history`), the standard floating-storage tell. This is the
  signal that *requires* persistence — dwell can exceed the 7-day raw-data
  window (§6).

---

## 6. Persistence, retention & point-in-time integrity

- **Raw `positions`** are pruned at **7 days** (free-tier disk; the live map
  reads denormalized `vessels.cur_*`, not the fact table).
- **Derived events** (`passages`, `gate_crossings`, `dark_events`,
  `sts_candidates`) are compact and retained long.
- **Daily rollups** (`daily_flows`, `daily_storage`, `daily_storage_vessel`)
  snapshot each **complete UTC day** once, **before** the prune reaches it, and
  are kept indefinitely (a few bytes/day). They are **immutable** once written —
  a day's number reflects what was known at the time, with **no lookahead**, so
  the history is suitable for honest backtesting. Day boundaries are UTC (DB
  session confirmed UTC).

---

## 7. Known limitations (read before quoting a number)

1. **Absolute volumes undercount** (partial AIS capture, §4). Trends, not levels.
2. **Cargo is inferred**, not measured — capacity from length (§2), load from a
   noisy draught field (§3). Figures are estimates within ~±20% at the hull level.
3. **Cargo grade is a size PROXY, not declared.** The feed carries no cargo
   grade — every liquid-bulk hull is typed only `"Tanker"` (verified: the record
   exposes name, imo, type, flag, dimensions, position, dest, eta, draught,
   status — no AIS ship-type code or cargo category). So the crude/product split
   (`byGrade`, `gradeBasis: "size-proxy"`) is inferred from length via the
   standard dirty/clean heuristic — Aframax and larger (≥ 228 m) ≈ crude/dirty,
   smaller (LR1/MR/Handy) ≈ clean product (`estimate.cargoProxy`). LR2 (clean,
   Aframax-size) is the known ambiguous case, and **gas carriers (LNG/LPG) cannot
   be separated at all** and are counted as crude-equivalent barrels — a genuine
   overstatement of oil for the minority of gas traffic. The `byClass` breakdown
   (VLCC/Suezmax/…) is exact from length; the crude/product rollup is the proxy.
4. **Direction is a longitude proxy**, not projected onto the gate normal — fine
   for the roughly NW–SE strait, weaker for oblique crossings.
5. **Sparse sampling** (§1) makes floating-storage speed/span noisy on
   low-fix vessels; the `minFixes` guard mitigates, not eliminates.
6. **Sanctions/shadow-fleet** signals are heuristic (dark-gap + proximity STS),
   strait-tuned, and the shipped watchlist is empty by default.

Every assumption above is a named constant in `config.FLOW` / `config.STORAGE` /
`config.INTEGRITY` and can be re-tuned without touching logic.
