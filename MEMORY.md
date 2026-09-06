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

- The manual `Deploy to Cloudflare` Actions workflow template is stored in
  `.github.example/workflows/deploy.yml`. Rename `.github.example` to `.github` and push to
  enable it, then run `Deploy to Cloudflare` from the Actions tab on `main`.
- The workflow deploys `main` using repository secrets
  `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. It builds and tests before deployment.
- Deployment stops when D1 migrations are pending. Review and apply them separately; migration
  0007 destroys existing position history and must not be applied without confirming that reset.
