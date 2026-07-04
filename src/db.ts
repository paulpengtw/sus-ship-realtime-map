// src/db.ts
import { newVesselState, type AisPosition, type AnomalyEvent, type VesselState } from "./types";

export interface PendingWrites {
  positions: AisPosition[];
  events: AnomalyEvent[];
  vessels: Map<number, VesselState>;
}

export function newPendingWrites(): PendingWrites {
  return { positions: [], events: [], vessels: new Map() };
}

export async function flushWrites(db: D1Database, p: PendingWrites): Promise<void> {
  const stmts: D1PreparedStatement[] = [];

  for (const s of p.vessels.values()) {
    const lp = s.ring[s.ring.length - 1];
    if (!lp) continue;
    stmts.push(db.prepare(
      `INSERT INTO vessels (mmsi, name, callsign, last_lon, last_lat, last_sog, last_cog, last_ts, score, score_ts)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
       ON CONFLICT (mmsi) DO UPDATE SET name = ?2, callsign = ?3, last_lon = ?4, last_lat = ?5,
         last_sog = ?6, last_cog = ?7, last_ts = ?8, score = ?9, score_ts = ?10`,
    ).bind(s.mmsi, s.name, s.callsign, lp.lon, lp.lat, lp.sog, lp.cog, s.lastSeen, s.score, s.scoreTs));
  }

  for (const pos of p.positions) {
    stmts.push(db.prepare(
      `INSERT OR REPLACE INTO positions (mmsi, ts, lon, lat, sog, cog) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(pos.mmsi, pos.ts, pos.lon, pos.lat, pos.sog, pos.cog));
  }

  for (const ev of p.events) {
    stmts.push(db.prepare(
      `INSERT INTO events (id, type, severity, mmsi, lon, lat, start_ts, end_ts, evidence)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT (id) DO UPDATE SET severity = ?3, lon = ?5, lat = ?6, end_ts = ?8, evidence = ?9`,
    ).bind(ev.id, ev.type, ev.severity, ev.mmsi, ev.lon, ev.lat, ev.startTs, ev.endTs, JSON.stringify(ev.evidence)));
  }

  if (stmts.length) await db.batch(stmts);
}

export async function loadRecentVesselStates(db: D1Database, sinceTs: number): Promise<VesselState[]> {
  const { results } = await db.prepare(`SELECT * FROM vessels WHERE last_ts >= ?1`).bind(sinceTs).all<any>();
  return results.map((r) => {
    const s = newVesselState(r.mmsi, r.last_ts);
    s.name = r.name; s.callsign = r.callsign;
    s.score = r.score; s.scoreTs = r.score_ts;
    s.lastSeen = r.last_ts;
    s.ring.push({ mmsi: r.mmsi, lon: r.last_lon, lat: r.last_lat, sog: r.last_sog, cog: r.last_cog, heading: null, ts: r.last_ts });
    return s;
  });
}

export async function pruneOldPositions(db: D1Database, beforeTs: number): Promise<void> {
  await db.prepare(`DELETE FROM positions WHERE ts < ?1`).bind(beforeTs).run();
}
