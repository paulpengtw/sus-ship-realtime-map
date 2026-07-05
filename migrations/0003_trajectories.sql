-- migrations/0003_trajectories.sql — historical trajectories (spec §1): GFW on-demand backfill bookkeeping.
ALTER TABLE vessels ADD COLUMN gfw_id TEXT;

CREATE TABLE gfw_backfill (
  mmsi INTEGER PRIMARY KEY,
  gfw_id TEXT,               -- NULL = vessel unknown to GFW (negative cache, honored for 24 h too)
  fetched_ts INTEGER NOT NULL
);

-- /api/vessel/:mmsi/track reads breadcrumbs by vessel.
CREATE INDEX idx_gfw_events_mmsi ON gfw_events (mmsi);
