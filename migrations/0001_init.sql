-- migrations/0001_init.sql
CREATE TABLE vessels (
  mmsi INTEGER PRIMARY KEY,
  name TEXT,
  callsign TEXT,
  last_lon REAL NOT NULL,
  last_lat REAL NOT NULL,
  last_sog REAL NOT NULL,
  last_cog REAL NOT NULL,
  last_ts INTEGER NOT NULL,
  score REAL NOT NULL DEFAULT 0,
  score_ts INTEGER NOT NULL
);
CREATE INDEX idx_vessels_last_ts ON vessels (last_ts);

CREATE TABLE positions (
  mmsi INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  lon REAL NOT NULL,
  lat REAL NOT NULL,
  sog REAL NOT NULL,
  cog REAL NOT NULL,
  PRIMARY KEY (mmsi, ts)
);
CREATE INDEX idx_positions_ts ON positions (ts);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  severity INTEGER NOT NULL,
  mmsi INTEGER NOT NULL,
  lon REAL NOT NULL,
  lat REAL NOT NULL,
  start_ts INTEGER NOT NULL,
  end_ts INTEGER,
  evidence TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_events_start_ts ON events (start_ts);
CREATE INDEX idx_events_mmsi ON events (mmsi);

CREATE TABLE gfw_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  mmsi INTEGER,
  lon REAL NOT NULL,
  lat REAL NOT NULL,
  start_ts INTEGER NOT NULL,
  end_ts INTEGER,
  raw TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_gfw_events_start_ts ON gfw_events (start_ts);
