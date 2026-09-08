# Project memory

This file holds durable facts for future sessions.

## 2026-09-05 — D1 free tier

- D1 free tier caps: 100k rows_written/day, 5M rows_read/day. Index rows and DELETEs count as writes.
- Never add a per-flush or per-poll D1 query. Hot reads come from TrackerDO memory (`/snapshot`,
  `/vessel-counts`, `/vessel/:mmsi`); hot writes go through `flushPending` under `WriteMeter`.
- Do not add secondary indexes to `positions` or `vessels` without re-running the budget in
  `docs/superpowers/specs/2026-09-05-d1-free-tier-write-budget-design.md` §4.
- A single always-on Durable Object uses ~83% of the free 13k GB-s/day. No second always-on DO.

## 2026-09-07 — GitHub deployment

- The manual `Deploy to Cloudflare` Actions workflow is live at `.github/workflows/deploy.yml` and
  is dispatched from the Actions tab (`workflow_dispatch`) on `main` only.
- The workflow deploys `main` using repository secrets
  `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. It builds and tests before deployment.
- By default, deployment stops when D1 migrations are pending. The workflow has an opt-in
  `apply_migrations` boolean dispatch input (default `false`). When true, a guarded
  `Apply production migrations` step runs `npx wrangler d1 migrations apply cable-guard --remote`
  before the existing `Check production migrations` gate. The gate is unchanged and still fails the
  run if anything is still pending afterwards. Migration `0007` destroys existing position history
  and must not be applied without confirming that reset. Landed in PR #17, squash commit `eab9ed7`.

## 2026-09-08 — first real deployment

- Until this date, the write-budget work (PR #15) had never been deployed. Production was still
  running a worker from the `0003` (trajectories) era with migrations `0004`-`0007` all pending, which
  is why the D1 `rows_written` free-tier alerts kept firing—merging the fix did nothing on its own.
- The cheap way to tell what is actually deployed is to probe the live worker for a route that a
  known commit introduced. `GET /api/health` returning `404` while `/api/snapshot` returned `200`
  proved the deployed code predated commit `9191cf1`. Prefer that over assuming `main` is live.
- Migrations `0004`-`0007` were applied together on `2026-09-08` via the workflow. `0007` reset the
  `positions` history as designed. Combined write cost was negligible: `0004` and `0006` create
  empty tables, `0005` deletes from an empty table, and `0007` is a schema-level drop and recreate.
- Post-deploy verification: `GET /api/health` returns the `writes` block (`day`, `usedToday`,
  `budget` 80000, `optionalWritesPaused`). Worker Version ID
  `e3952f86-c517-4be7-890e-d25544cb4e2d`.
- Watch item: `usedToday` should read roughly 20k-40k near 23:59 UTC. The meter is in-memory, so a
  Durable Object restart resets it to 0 mid-day—a low reading is not by itself proof of low write
  volume.
