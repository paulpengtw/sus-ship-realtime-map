# demo 
- [https://cable-guard.cloudflare-com-652.workers.dev/](https://cable-guard.cloudflare-com-652.workers.dev/)

## Labeling (Phase 0 harness)

Generate candidate incidents from the last 30 days:

```
npm run dev &      # start the worker
npm run materialize -- --source=all --lookback-days=30 --origin=http://127.0.0.1:8787
```

Open `http://localhost:8787/#mode=review` to label. Progress and imbalance are shown at the top of
the queue. Target: ≥ 200 labels (≥ 40 threat, ≥ 100 benign) before Phase 1 model fitting.

## Free-tier write budget

The worker runs on the Cloudflare free tier (D1: 100k rows written / 5M rows read per day). Design
and numbers: `docs/superpowers/specs/2026-09-05-d1-free-tier-write-budget-design.md`.

- The live map (`/api/snapshot`), per-region vessel counts and the dossier's live position are served
  from Durable Object memory. D1 is not read on the 15 s poll path.
- `vessels` rows are written on change (first sight, identity change, event/assessment touch) or at
  most every `vesselRefreshMs` (6 h). `positions` rows are written only for tracked vessels (open
  assessment or category score ≥ `trackPersistMinScore`), gated at 10 min / 2 km.
- `GET /api/health` shows `writes: { day, usedToday, budget, optionalWritesPaused }`. Above
  `d1DailyWriteBudget` (80k) breadcrumbs and refreshes are dropped for the rest of the UTC day;
  assessments and events keep flowing.

### Deploying migration 0007

Migration 0007 drops and recreates `positions` (history reset — see the spec). Apply it while
quota is available, i.e. shortly after 00:00 UTC:

    npx wrangler d1 migrations apply cable-guard --remote
    npm run deploy
    curl -s https://<worker>/api/health | jq .writes

Watch `usedToday` for a day; expected 20k–40k at 23:59 UTC.
