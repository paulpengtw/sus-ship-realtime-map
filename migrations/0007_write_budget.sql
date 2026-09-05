-- migrations/0007_write_budget.sql — D1 free-tier write budget (spec 2026-09-05 §3).
-- positions is reset: only tracked vessels' breadcrumbs are persisted from now on, and deleting
-- the old rows one by one would itself cost more rows_written than a day's quota.
-- WITHOUT ROWID makes the (mmsi, ts) primary key the table itself: one insert = one row written.
-- No ts index: every reader filters by mmsi first (PK prefix) or scans a small table daily (thinning).
DROP INDEX IF EXISTS idx_positions_ts;
DROP TABLE positions;
CREATE TABLE positions (
  mmsi INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  lon REAL NOT NULL,
  lat REAL NOT NULL,
  sog REAL NOT NULL,
  cog REAL NOT NULL,
  PRIMARY KEY (mmsi, ts)
) WITHOUT ROWID;
-- vessels.last_ts was only read by the snapshot/stats queries, which now come from DO memory.
DROP INDEX IF EXISTS idx_vessels_last_ts;
