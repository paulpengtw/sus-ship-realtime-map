// src/persist-policy.ts — which in-memory state earns a D1 write (spec 2026-09-05 §3–4). Pure functions.
import { CONFIG, type Config } from "./config";
import { haversineM } from "./geo/geo";
import { THREAT_CATEGORIES, type AisPosition, type AnomalyEvent, type ThreatAssessment, type VesselState } from "./types";

/** What TrackerDO accumulates between flushes. Vessels are tracked by mmsi; their state is read at flush time. */
export interface PendingQueue {
  positions: AisPosition[];
  events: Map<string, AnomalyEvent>;          // keyed by id so a retried flush cannot duplicate
  dirtyVessels: Set<number>;
  assessments: Map<string, ThreatAssessment>;
}

export function newPendingQueue(): PendingQueue {
  return { positions: [], events: new Map(), dirtyVessels: new Set(), assessments: new Map() };
}

export interface VesselWriteRecord { ts: number; fp: string }

/** Identity and static data that, when changed, must reach the vessels registry promptly. */
export function vesselFingerprint(s: VesselState): string {
  return JSON.stringify([s.name, s.callsign, s.region, s.shipType, s.destination, s.dimBow, s.dimStern, s.dimPort, s.dimStarboard]);
}

export type VesselWriteKind = "essential" | "optional" | "skip";

/**
 * essential — first sight, identity/static change, or touched by an event/assessment this flush.
 * optional  — unchanged but the row is older than vesselRefreshMs (keeps the hydration window valid).
 * skip      — nothing to do.
 */
export function vesselWriteKind(
  s: VesselState, prev: VesselWriteRecord | undefined, now: number, touched: boolean, cfg: Config = CONFIG,
): VesselWriteKind {
  if (s.ring.length === 0) return "skip"; // flushWrites has no last fix to bind
  if (!prev || touched || prev.fp !== vesselFingerprint(s)) return "essential";
  if (now - prev.ts >= cfg.vesselRefreshMs) return "optional";
  return "skip";
}

export function isTracked(s: VesselState, cfg: Config = CONFIG): boolean {
  for (const c of THREAT_CATEGORIES) {
    if (s.assessments[c]?.status === "open") return true;
    if (s.categories[c].score >= cfg.trackPersistMinScore) return true;
  }
  return false;
}

export function shouldPersistPosition(pos: AisPosition, prev: AisPosition | undefined, cfg: Config = CONFIG): boolean {
  if (!prev) return true;
  return pos.ts - prev.ts >= cfg.persistMinIntervalMs
    || haversineM([prev.lon, prev.lat], [pos.lon, pos.lat]) >= cfg.persistMinMoveM;
}

/** One ring point per bucket inside the backfill window — queued once when a vessel becomes tracked. */
export function ringBackfill(s: VesselState, now: number, cfg: Config = CONFIG): AisPosition[] {
  const out: AisPosition[] = [];
  let lastBucket = Number.NaN;
  for (const p of s.ring) {
    if (p.ts < now - cfg.trackBackfillWindowMs) continue;
    const bucket = Math.floor(p.ts / cfg.trackBackfillBucketMs);
    if (bucket === lastBucket) continue;
    lastBucket = bucket;
    out.push(p);
  }
  return out;
}

export function truncatePositions(positions: AisPosition[], cap: number): AisPosition[] {
  return positions.length <= cap ? positions : positions.slice(positions.length - cap);
}
