-- migrations/0002_regions.sql - region tagging + richer vessel static data (spec §1).
ALTER TABLE vessels ADD COLUMN region TEXT;
ALTER TABLE vessels ADD COLUMN ship_type INTEGER;
ALTER TABLE vessels ADD COLUMN destination TEXT;
ALTER TABLE vessels ADD COLUMN dim_bow INTEGER;
ALTER TABLE vessels ADD COLUMN dim_stern INTEGER;
ALTER TABLE vessels ADD COLUMN dim_port INTEGER;
ALTER TABLE vessels ADD COLUMN dim_starboard INTEGER;
ALTER TABLE events ADD COLUMN region TEXT;

-- Backfill: everything ingested before this migration was Taiwan-only.
UPDATE vessels SET region = 'tw';
UPDATE events SET region = 'tw';

CREATE INDEX idx_vessels_region ON vessels (region);
CREATE INDEX idx_events_region ON events (region);
