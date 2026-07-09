# Deploying Ariadne (Railway, two services)

Architecture: **DB on Supabase** (already hosted) + **two always-on Railway
services from this one repo**:

| Service | Start command | Purpose | Public URL? |
| --- | --- | --- | --- |
| `web` | `npm start` (`node server.js`) | Serves the map + read APIs | Yes |
| `ingest` | `npm run ingest` (`node ingest.js`) | 24/7 ingestion loop | No |

Both connect to the same Supabase `DATABASE_URL`. The worker is the spine —
**a minute of ingestion missed is unrecoverable** (see PLAN.md §1).

---

## 1. Push the repo to GitHub

```bash
# create an empty repo at https://github.com/new (e.g. "ariadne"), then:
git remote add origin git@github.com:<you>/ariadne.git
git push -u origin main
```

## 2. Create the Railway project + web service

1. https://railway.app → **New Project → Deploy from GitHub repo** → pick the repo.
2. Railway auto-detects Node and runs `npm start` (the web server). No config needed.
3. **Settings → Networking → Generate Domain** to get a public URL for the map.
4. Add the **web env vars** (see table below).

## 3. Add the ingest worker service

1. In the same project: **+ New → GitHub Repo → same repo**.
2. **Settings → Deploy → Start Command:** `npm run ingest`
3. This service needs **no** public domain.
4. Add the **worker env vars** (see table below).

---

## Environment variables

Copy the secret values from your local `.env` (never commit it). Set **PORT
nowhere** — Railway injects it and `server.js` reads it (`lib/config.js`).

### `web` service
| Var | Value | Notes |
| --- | --- | --- |
| `DATABASE_URL` | *(from .env)* | Supabase connection string |
| `INGEST_TOKEN` | *(from .env)* | Protects `POST /api/ingest` |
| `LIVE_WINDOW_MIN` | `60` | |
| `POSITIONS_RETENTION_DAYS` | `7` | keep small on free-tier disk (see note) |
| `MARINESIA_API_KEY` | *(from .env)* | Only needed if you use the manual `/api/ingest` trigger; otherwise omit |

> ⚠️ **Do NOT set `RUN_INGEST_IN_PROCESS=1` on the web service.** That flag makes
> the web process *also* run the ingest loop, so you'd have two pollers and blow
> the Marinesia 5-calls/min budget. Leave it unset (default is off).

### `ingest` service
| Var | Value | Notes |
| --- | --- | --- |
| `DATABASE_URL` | *(from .env)* | same Supabase string |
| `MARINESIA_API_KEY` | *(from .env)* | **required** — the worker fetches |
| `INGEST_INTERVAL_MS` | `60000` | one cycle/min (matches the 5/min budget) |
| `POSITIONS_RETENTION_DAYS` | `7` | worker runs the prune; keep small (see note) |
| `TILES_PER_CYCLE` | *(optional)* | default 3 |
| `BACKFILL_PER_CYCLE` | *(optional)* | default 1 |

> ⚠️ **Free-tier disk.** The `positions` fact table grows ~15–20 MB/day with
> Gulf-wide tiling. At the old 30-day retention it reached ~380 MB and **filled
> the Supabase free-tier disk, crash-looping Postgres** (`No space left on
> device` in WAL). Keep `POSITIONS_RETENTION_DAYS` small (7 ≈ ~130 MB, plateaus
> safely). The live map no longer needs deep history — it reads the denormalized
> `vessels.cur_*` columns, not the fact table.

---

## 4. Verify it's live

- **Map:** open the web service's generated domain → vessels render.
- **Ingestor:** Railway → `ingest` service → **Deployments → Logs**. You should
  see a line per cycle, e.g. `[ingest] ...Z tiles=hormuz+... seen=... stored=...`.
- **Freshness check:** the map's `/api/ships` keeps returning recent positions
  with no browser tab needed — that's the proof ingestion is viewer-independent.

## Cost

Two small always-on services land roughly **$5–10/mo** on Railway's Hobby plan
(usage-based; the $5 plan includes $5 of usage). If you later want the frontend
free + CDN-fast, move only the `web` service to Vercel (serverless funcs) and
keep the worker on Railway — a clean, self-contained migration.
