# Project memory

This file holds durable facts for future sessions.

## 2026-09-05 — D1 free tier

- D1 free tier caps: 100k rows_written/day, 5M rows_read/day. Index rows and DELETEs count as writes.
- Never add a per-flush or per-poll D1 query. Hot reads come from TrackerDO memory (`/snapshot`,
  `/vessel-counts`, `/vessel/:mmsi`); hot writes go through `flushPending` under `WriteMeter`.
- Do not add secondary indexes to `positions` or `vessels` without re-running the budget in
  `docs/superpowers/specs/2026-09-05-d1-free-tier-write-budget-design.md` §4.
- A single always-on Durable Object uses ~83% of the free 13k GB-s/day. No second always-on DO.
