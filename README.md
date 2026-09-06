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

### Continuous deployment

`.github/workflows/deploy.yml` deploys on every push to `main` and on manual dispatch
(Actions → Deploy → Run workflow). Each run does `npm ci`, `npm test`, `npm run build:web`,
`wrangler d1 migrations apply cable-guard --remote`, then `wrangler deploy`, in that order,
one run at a time.

Repository secrets required (Settings → Secrets and variables → Actions):

- `CLOUDFLARE_API_TOKEN` — a custom token scoped to this account with
  **Account → Workers Scripts: Edit**, **Account → D1: Edit**, **Account → Account Settings: Read**.
  Give it an expiry and rotate it.
- `CLOUDFLARE_ACCOUNT_ID` — the account id shown on the Workers overview page.

The job runs in the `production` GitHub environment, so a required-reviewer rule can be
attached there to make deploys click-to-approve. Worker secrets (`AISSTREAM_KEY`,
`GFW_TOKEN`) live on the worker and are untouched by deploys.

Because a new migration's DDL costs D1 rows_written, merge or dispatch a run that carries a
new migration shortly after 00:00 UTC.
