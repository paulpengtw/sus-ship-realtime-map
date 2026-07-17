// src/db.ts
import { maxCategoryScore } from "./fusion";
import { newVesselState, type AisPosition, type AnomalyEvent, type ThreatAssessment, type VesselState } from "./types";

export interface PendingWrites {
  positions: AisPosition[];
  events: AnomalyEvent[];
  vessels: Map<number, VesselState>;
  assessments: Map<string, ThreatAssessment>;
}

export function newPendingWrites(): PendingWrites {
  return { positions: [], events: [], vessels: new Map(), assessments: new Map() };
}

export async function flushWrites(db: D1Database, p: PendingWrites): Promise<void> {
  const stmts: D1PreparedStatement[] = [];

  for (const s of p.vessels.values()) {
    const lp = s.ring[s.ring.length - 1];
    if (!lp) continue;
    const legacy = maxCategoryScore(s);
    stmts.push(db.prepare(
      `INSERT INTO vessels (mmsi, name, callsign, last_lon, last_lat, last_sog, last_cog, last_ts, score, score_ts,
                            region, ship_type, destination, dim_bow, dim_stern, dim_port, dim_starboard)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
       ON CONFLICT (mmsi) DO UPDATE SET name = ?2, callsign = ?3, last_lon = ?4, last_lat = ?5,
         last_sog = ?6, last_cog = ?7, last_ts = ?8, score = ?9, score_ts = ?10,
         region = ?11, ship_type = ?12, destination = ?13, dim_bow = ?14, dim_stern = ?15, dim_port = ?16, dim_starboard = ?17`,
    ).bind(s.mmsi, s.name, s.callsign, lp.lon, lp.lat, lp.sog, lp.cog, s.lastSeen, legacy.score, legacy.ts,
           s.region, s.shipType, s.destination, s.dimBow, s.dimStern, s.dimPort, s.dimStarboard));
  }

  for (const pos of p.positions) {
    stmts.push(db.prepare(
      `INSERT OR REPLACE INTO positions (mmsi, ts, lon, lat, sog, cog) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(pos.mmsi, pos.ts, pos.lon, pos.lat, pos.sog, pos.cog));
  }

  for (const ev of p.events) {
    stmts.push(db.prepare(
      `INSERT INTO events (id, type, severity, mmsi, lon, lat, start_ts, end_ts, evidence, region)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
       ON CONFLICT (id) DO UPDATE SET severity = ?3, lon = ?5, lat = ?6, end_ts = ?8, evidence = ?9, region = ?10`,
    ).bind(ev.id, ev.type, ev.severity, ev.mmsi, ev.lon, ev.lat, ev.startTs, ev.endTs, JSON.stringify(ev.evidence), ev.region ?? null));
  }

  for (const a of p.assessments.values()) {
    stmts.push(db.prepare(
      `INSERT INTO assessments (id, mmsi, category, status, confidence, opened_ts, updated_ts, closed_ts, region, narrative, evidence)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
       ON CONFLICT (id) DO UPDATE SET status = ?4, confidence = ?5, updated_ts = ?7, closed_ts = ?8, region = ?9, narrative = ?10, evidence = ?11`,
    ).bind(a.id, a.mmsi, a.category, a.status, a.confidence, a.openedTs, a.updatedTs, a.closedTs, a.region ?? null, a.narrative, JSON.stringify(a.evidence)));
  }

  if (stmts.length) await db.batch(stmts);
}

export async function loadRecentVesselStates(db: D1Database, sinceTs: number): Promise<VesselState[]> {
  const { results } = await db.prepare(`SELECT * FROM vessels WHERE last_ts >= ?1`).bind(sinceTs).all<any>();
  return results.map((r) => {
    const s = newVesselState(r.mmsi, r.last_ts);
    s.name = r.name; s.callsign = r.callsign;
    s.region = r.region ?? null;
    s.shipType = r.ship_type ?? null;
    s.destination = r.destination ?? null;
    s.dimBow = r.dim_bow ?? null; s.dimStern = r.dim_stern ?? null;
    s.dimPort = r.dim_port ?? null; s.dimStarboard = r.dim_starboard ?? null;
    s.lastSeen = r.last_ts;
    s.ring.push({ mmsi: r.mmsi, lon: r.last_lon, lat: r.last_lat, sog: r.last_sog, cog: r.last_cog, heading: null, ts: r.last_ts });
    return s;
  });
}

export async function loadOpenAssessments(db: D1Database): Promise<ThreatAssessment[]> {
  const { results } = await db.prepare(`SELECT * FROM assessments WHERE status = 'open'`).all<any>();
  return results.map((r) => ({
    id: r.id, mmsi: r.mmsi, category: r.category, status: r.status,
    confidence: r.confidence, openedTs: r.opened_ts, updatedTs: r.updated_ts, closedTs: r.closed_ts,
    evidence: JSON.parse(r.evidence ?? "[]"), narrative: r.narrative,
    region: r.region ?? null, lastLon: 0, lastLat: 0,
  }));
}

export interface RetentionTier { minAgeMs: number; maxAgeMs: number; bucketMs: number }

// Tiered thinning (trajectories spec §1): within each age tier keep the earliest point per
// (mmsi, time-bucket); everything older than the last tier is deleted outright.
export async function thinPositions(db: D1Database, now: number, tiers: readonly RetentionTier[]): Promise<void> {
  if (!tiers.length) return;
  const stmts = tiers.map((t) => db.prepare(
    `DELETE FROM positions
     WHERE ts >= ?1 AND ts < ?2
       AND (mmsi, ts) NOT IN (
         SELECT mmsi, MIN(ts) FROM positions
         WHERE ts >= ?1 AND ts < ?2
         GROUP BY mmsi, CAST(ts / ?3 AS INTEGER)
       )`,
  ).bind(now - t.maxAgeMs, now - t.minAgeMs, t.bucketMs));
  const oldestMs = Math.max(...tiers.map((t) => t.maxAgeMs));
  stmts.push(db.prepare(`DELETE FROM positions WHERE ts < ?1`).bind(now - oldestMs));
  await db.batch(stmts);
}
