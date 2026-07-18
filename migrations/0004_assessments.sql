-- migrations/0004_assessments.sql — threat assessment fusion (spec §5).
CREATE TABLE assessments (
  id TEXT PRIMARY KEY,
  mmsi INTEGER NOT NULL,
  category TEXT NOT NULL,
  status TEXT NOT NULL,           -- 'open' | 'closed'
  confidence REAL NOT NULL,
  opened_ts INTEGER NOT NULL,
  updated_ts INTEGER NOT NULL,
  closed_ts INTEGER,
  region TEXT,
  narrative TEXT NOT NULL,
  evidence TEXT NOT NULL,         -- JSON EvidenceRef[]
  last_lon REAL NOT NULL DEFAULT 0,
  last_lat REAL NOT NULL DEFAULT 0
);
CREATE INDEX idx_assessments_status_region ON assessments (status, region, updated_ts);
CREATE INDEX idx_assessments_mmsi ON assessments (mmsi, updated_ts);
