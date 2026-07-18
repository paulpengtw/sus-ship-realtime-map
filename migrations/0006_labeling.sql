-- migrations/0006_labeling.sql — labeling harness (spec §3a).
CREATE TABLE candidate_incidents (
  id TEXT PRIMARY KEY,
  vessel_id TEXT NOT NULL,
  t_start INTEGER NOT NULL,
  t_end INTEGER NOT NULL,
  source TEXT NOT NULL,
  source_ref TEXT,
  created_at INTEGER NOT NULL,
  model_snapshot TEXT,
  event_ids TEXT
);
CREATE INDEX ix_candidate_source ON candidate_incidents(source, created_at);
CREATE INDEX ix_candidate_vessel ON candidate_incidents(vessel_id, t_start);

CREATE TABLE labels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id TEXT NOT NULL REFERENCES candidate_incidents(id),
  labeler TEXT NOT NULL,
  ts INTEGER NOT NULL,
  verdict TEXT NOT NULL,
  intent_categories TEXT,
  labeler_confidence INTEGER,
  notes TEXT,
  UNIQUE(incident_id, labeler)
);
CREATE INDEX ix_labels_verdict ON labels(verdict, ts);
