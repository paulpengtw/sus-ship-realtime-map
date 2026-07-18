-- migrations/0007_candidate_incidents_id_notnull.sql
-- Enforce NOT NULL on candidate_incidents.id (SQLite quirk: TEXT PRIMARY KEY
-- alone does not imply NOT NULL). Table recreate is the standard workaround.

PRAGMA foreign_keys=OFF;

CREATE TABLE candidate_incidents_new (
  id TEXT NOT NULL PRIMARY KEY,
  vessel_id TEXT NOT NULL,
  t_start INTEGER NOT NULL,
  t_end INTEGER NOT NULL,
  source TEXT NOT NULL,
  source_ref TEXT,
  created_at INTEGER NOT NULL,
  model_snapshot TEXT,
  event_ids TEXT
);

INSERT INTO candidate_incidents_new
  (id, vessel_id, t_start, t_end, source, source_ref, created_at, model_snapshot, event_ids)
SELECT id, vessel_id, t_start, t_end, source, source_ref, created_at, model_snapshot, event_ids
FROM candidate_incidents;

DROP TABLE candidate_incidents;
ALTER TABLE candidate_incidents_new RENAME TO candidate_incidents;

CREATE INDEX ix_candidate_source ON candidate_incidents(source, created_at);
CREATE INDEX ix_candidate_vessel ON candidate_incidents(vessel_id, t_start);

PRAGMA foreign_keys=ON;
