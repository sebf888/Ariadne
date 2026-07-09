-- Ariadne — Phase 0 schema (Postgres + PostGIS)
-- Apply with: npm run migrate   (or paste into the Supabase SQL editor)

CREATE EXTENSION IF NOT EXISTS postgis;

-- Dimension: one row per vessel (MMSI), upserted on every sighting.
CREATE TABLE IF NOT EXISTS vessels (
  mmsi        BIGINT PRIMARY KEY,
  imo         BIGINT,
  name        TEXT,
  type        TEXT,
  flag        TEXT,
  a           INTEGER,
  b           INTEGER,
  c           INTEGER,
  d           INTEGER,
  -- AIS dimensions: length = a+b (bow+stern), beam = c+d (port+starboard)
  length      INTEGER GENERATED ALWAYS AS (COALESCE(a, 0) + COALESCE(b, 0)) STORED,
  beam        INTEGER GENERATED ALWAYS AS (COALESCE(c, 0) + COALESCE(d, 0)) STORED,
  -- Enrichment columns (populated in later phases for barrel estimates etc.)
  dwt              INTEGER,
  cargo_capacity_bbl BIGINT,
  design_draught   DOUBLE PRECISION,
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- When we last pulled this vessel's historical track (NULL = needs backfill).
  backfilled_at TIMESTAMPTZ
);

-- Idempotent add for databases created before backfill existed.
ALTER TABLE vessels ADD COLUMN IF NOT EXISTS backfilled_at TIMESTAMPTZ;

-- Denormalized "current position": the vessel's latest AIS report mirrored onto
-- the dimension row. The live map reads one row per vessel from here instead of
-- computing DISTINCT ON over the multi-million-row positions fact (which timed
-- out once Gulf-wide tiling grew the data). Maintained by buildVesselUpsert
-- (advanced only when a newer cur_ts arrives) and seeded by
-- scripts/backfill-current-pos.js. Mirrors the positions columns minus geom.
ALTER TABLE vessels ADD COLUMN IF NOT EXISTS cur_lat     DOUBLE PRECISION;
ALTER TABLE vessels ADD COLUMN IF NOT EXISTS cur_lng     DOUBLE PRECISION;
ALTER TABLE vessels ADD COLUMN IF NOT EXISTS cur_sog     DOUBLE PRECISION;
ALTER TABLE vessels ADD COLUMN IF NOT EXISTS cur_cog     DOUBLE PRECISION;
ALTER TABLE vessels ADD COLUMN IF NOT EXISTS cur_hdt     INTEGER;
ALTER TABLE vessels ADD COLUMN IF NOT EXISTS cur_rot     DOUBLE PRECISION;
ALTER TABLE vessels ADD COLUMN IF NOT EXISTS cur_draught DOUBLE PRECISION;
ALTER TABLE vessels ADD COLUMN IF NOT EXISTS cur_status  INTEGER;
ALTER TABLE vessels ADD COLUMN IF NOT EXISTS cur_dest    TEXT;
ALTER TABLE vessels ADD COLUMN IF NOT EXISTS cur_eta     TEXT;
ALTER TABLE vessels ADD COLUMN IF NOT EXISTS cur_ts      TIMESTAMPTZ;

-- Fact: the position time-series. Append-only, idempotent on (mmsi, ts).
CREATE TABLE IF NOT EXISTS positions (
  mmsi     BIGINT NOT NULL,
  ts       TIMESTAMPTZ NOT NULL,
  lat      DOUBLE PRECISION NOT NULL,
  lng      DOUBLE PRECISION NOT NULL,
  geom     geometry(Point, 4326) GENERATED ALWAYS AS
             (ST_SetSRID(ST_MakePoint(lng, lat), 4326)) STORED,
  sog      DOUBLE PRECISION,   -- speed over ground (knots)
  cog      DOUBLE PRECISION,   -- course over ground (deg)
  hdt      INTEGER,            -- true heading (deg; 511 = unavailable)
  rot      DOUBLE PRECISION,   -- rate of turn
  draught  DOUBLE PRECISION,   -- not in area feed; filled by backfill/enrichment
  status   INTEGER,            -- AIS navigational status code
  dest     TEXT,
  eta      TEXT,
  PRIMARY KEY (mmsi, ts)
);

CREATE INDEX IF NOT EXISTS positions_ts_idx       ON positions (ts);
CREATE INDEX IF NOT EXISTS positions_mmsi_ts_idx  ON positions (mmsi, ts DESC);
CREATE INDEX IF NOT EXISTS positions_geom_idx     ON positions USING GIST (geom);

-- Transit events: a vessel crossing the tripwire line. Idempotent on (mmsi, ts).
CREATE TABLE IF NOT EXISTS transits (
  mmsi       BIGINT NOT NULL,
  ts         TIMESTAMPTZ NOT NULL,     -- time of the crossing position
  direction  TEXT NOT NULL,            -- 'inbound' (into Gulf) | 'outbound' (exports)
  type       TEXT,                     -- vessel type at crossing
  sog        DOUBLE PRECISION,
  draught    DOUBLE PRECISION,         -- for later barrel-flow estimates
  cross_lat  DOUBLE PRECISION,
  cross_lng  DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (mmsi, ts)
);
CREATE INDEX IF NOT EXISTS transits_ts_idx     ON transits (ts);
CREATE INDEX IF NOT EXISTS transits_dir_ts_idx ON transits (direction, ts);

-- Two-gate cordon model -----------------------------------------------------

-- Raw crossings of either gate (gross activity + building block for passages).
CREATE TABLE IF NOT EXISTS gate_crossings (
  mmsi       BIGINT NOT NULL,
  ts         TIMESTAMPTZ NOT NULL,
  gate       TEXT NOT NULL,            -- 'W' (Gulf side) | 'E' (Oman side)
  direction  TEXT NOT NULL,            -- 'inbound' (into Gulf) | 'outbound' (exports)
  type       TEXT,
  sog        DOUBLE PRECISION,
  draught    DOUBLE PRECISION,
  cross_lat  DOUBLE PRECISION,
  cross_lng  DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (mmsi, ts, gate)
);
CREATE INDEX IF NOT EXISTS gate_crossings_ts_idx      ON gate_crossings (ts);
CREATE INDEX IF NOT EXISTS gate_crossings_mmsi_ts_idx ON gate_crossings (mmsi, ts);

-- Completed strait passages: entered one gate, exited the other in sequence.
CREATE TABLE IF NOT EXISTS passages (
  mmsi        BIGINT NOT NULL,
  entry_ts    TIMESTAMPTZ NOT NULL,
  exit_ts     TIMESTAMPTZ NOT NULL,
  entry_gate  TEXT NOT NULL,
  exit_gate   TEXT NOT NULL,
  direction   TEXT NOT NULL,           -- inbound | outbound
  transit_min DOUBLE PRECISION,        -- minutes between gates
  type        TEXT,
  draught     DOUBLE PRECISION,
  flags       TEXT[] NOT NULL DEFAULT '{}',  -- e.g. {slow}
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (mmsi, entry_ts)
);
CREATE INDEX IF NOT EXISTS passages_exit_ts_idx ON passages (exit_ts);
CREATE INDEX IF NOT EXISTS passages_dir_idx     ON passages (direction, exit_ts);

-- Integrity layer (Phase 4) --------------------------------------------------

-- Dark events: a vessel that went quiet while plausibly still inside the cordon
-- and under way. Detection of *absence* — only meaningful with gap-free
-- sampling. Open while resumed_ts IS NULL; closed (with the re-appearance gap
-- and how far it jumped) when the MMSI transmits again.
CREATE TABLE IF NOT EXISTS dark_events (
  mmsi         BIGINT NOT NULL,
  went_dark_ts TIMESTAMPTZ NOT NULL,    -- last time we saw it (ingestion time)
  last_lat     DOUBLE PRECISION,
  last_lng     DOUBLE PRECISION,
  last_sog     DOUBLE PRECISION,
  type         TEXT,
  resumed_ts   TIMESTAMPTZ,             -- NULL = still dark
  gap_min      DOUBLE PRECISION,        -- minutes dark (set on resume)
  resume_lat   DOUBLE PRECISION,
  resume_lng   DOUBLE PRECISION,
  resume_km    DOUBLE PRECISION,        -- distance between vanish and re-appearance
  flags        TEXT[] NOT NULL DEFAULT '{}',  -- e.g. {jumped}
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (mmsi, went_dark_ts)
);
CREATE INDEX IF NOT EXISTS dark_events_open_idx ON dark_events (mmsi) WHERE resumed_ts IS NULL;
CREATE INDEX IF NOT EXISTS dark_events_ts_idx   ON dark_events (went_dark_ts);

-- Ship-to-ship transfer candidates: two slow vessels held alongside (within a
-- few hundred metres) over a sustained window. One row per pairing episode;
-- extended each cycle they stay together, a new row when they re-pair after
-- separating. Canonical ordering mmsi_a < mmsi_b so each pair is stored once.
CREATE TABLE IF NOT EXISTS sts_candidates (
  mmsi_a     BIGINT NOT NULL,
  mmsi_b     BIGINT NOT NULL,
  first_ts   TIMESTAMPTZ NOT NULL,      -- start of this alongside episode
  last_ts    TIMESTAMPTZ NOT NULL,      -- last cycle they were still alongside
  dur_min    DOUBLE PRECISION NOT NULL DEFAULT 0,
  min_dist_m DOUBLE PRECISION,          -- closest approach seen in the episode
  last_lat   DOUBLE PRECISION,
  last_lng   DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (mmsi_a, mmsi_b, first_ts)
);
CREATE INDEX IF NOT EXISTS sts_candidates_last_idx ON sts_candidates (last_ts);

-- Identity changes: append-only log of name/flag/IMO mutations for an MMSI.
-- Flag-hopping and (especially) a changed IMO are strong shadow-fleet /
-- identity-fraud tells — a hull's IMO should never change. Captured by a
-- trigger on vessels so the bulk upsert path stays untouched.
CREATE TABLE IF NOT EXISTS identity_changes (
  mmsi    BIGINT NOT NULL,
  ts      TIMESTAMPTZ NOT NULL DEFAULT now(),
  field   TEXT NOT NULL,            -- 'name' | 'flag' | 'imo'
  old_val TEXT,
  new_val TEXT,
  PRIMARY KEY (mmsi, ts, field)
);
CREATE INDEX IF NOT EXISTS identity_changes_mmsi_idx ON identity_changes (mmsi, ts);

CREATE OR REPLACE FUNCTION log_identity_change() RETURNS trigger AS $$
BEGIN
  -- Only log real mutations (old + new both present) so first-sighting fills
  -- and feed dropouts don't masquerade as identity changes. Name is
  -- deliberately NOT logged: AIS feeds flap name spellings (e.g. a "LC "
  -- prefix) every few cycles, which is pure noise — flag and (permanent) IMO
  -- are the shadow-fleet signals worth keeping.
  IF NEW.flag IS DISTINCT FROM OLD.flag AND OLD.flag IS NOT NULL AND NEW.flag IS NOT NULL THEN
    INSERT INTO identity_changes (mmsi, field, old_val, new_val)
    VALUES (NEW.mmsi, 'flag', OLD.flag, NEW.flag) ON CONFLICT DO NOTHING;
  END IF;
  IF NEW.imo IS DISTINCT FROM OLD.imo AND OLD.imo IS NOT NULL AND NEW.imo IS NOT NULL THEN
    INSERT INTO identity_changes (mmsi, field, old_val, new_val)
    VALUES (NEW.mmsi, 'imo', OLD.imo::text, NEW.imo::text) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vessels_identity_change ON vessels;
CREATE TRIGGER vessels_identity_change
  BEFORE UPDATE ON vessels
  FOR EACH ROW EXECUTE FUNCTION log_identity_change();

-- Bookkeeping for ingestion cycles (lets us detect gaps / monitor health).
CREATE TABLE IF NOT EXISTS ingest_runs (
  id          BIGSERIAL PRIMARY KEY,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  vessel_count INTEGER,
  ok          BOOLEAN,
  error       TEXT
);
