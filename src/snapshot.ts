// src/snapshot.ts — live-map read models built from TrackerDO in-memory state (spec 2026-09-05 §3).
// Pure functions: no D1, no DO. TrackerDO wraps them in routes; the worker proxies to those routes.
import { CONFIG, type RegionId } from "./config";
import type { VesselState } from "./types";

export interface SnapshotAssessment { category: string; confidence: number }

export interface SnapshotFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: {
    mmsi: number; name: string | null; sog: number; cog: number; lastTs: number;
    region: string | null; shipType: number | null;
    assessments: SnapshotAssessment[]; topCategory: string | null; maxConfidence: number;
    score: number; // legacy, remove next release
  };
}

export interface SnapshotResponse {
  generatedAt: number;
  newestTs: number | null;
  vessels: { type: "FeatureCollection"; features: SnapshotFeature[] };
}

export interface LiveVessel {
  mmsi: number; name: string | null; callsign: string | null;
  lon: number; lat: number; sog: number; cog: number; lastTs: number;
  region: string | null; shipType: number | null; destination: string | null;
  dimBow: number | null; dimStern: number | null; dimPort: number | null; dimStarboard: number | null;
}

export function openAssessments(s: VesselState): SnapshotAssessment[] {
  const out: SnapshotAssessment[] = [];
  for (const a of Object.values(s.assessments)) {
    if (a && a.status === "open") out.push({ category: a.category, confidence: a.confidence });
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}

function inWindow(s: VesselState, now: number, windowMs: number, region: string): boolean {
  return s.ring.length > 0 && s.lastSeen >= now - windowMs && (region === "" || s.region === region);
}

export function buildSnapshot(
  states: Iterable<VesselState>, now: number, region = "", windowMs: number = CONFIG.snapshotWindowMs,
): SnapshotResponse {
  const features: SnapshotFeature[] = [];
  let newestTs = 0;
  for (const s of states) {
    if (!inWindow(s, now, windowMs, region)) continue;
    const lp = s.ring[s.ring.length - 1];
    const assessments = openAssessments(s);
    const maxConfidence = assessments[0]?.confidence ?? 0;
    newestTs = Math.max(newestTs, s.lastSeen);
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [lp.lon, lp.lat] },
      properties: {
        mmsi: s.mmsi, name: s.name, sog: lp.sog, cog: lp.cog, lastTs: s.lastSeen,
        region: s.region ?? null, shipType: s.shipType ?? null,
        assessments, topCategory: assessments[0]?.category ?? null, maxConfidence,
        score: Math.round(maxConfidence * 5 * 10) / 10,
      },
    });
  }
  features.sort((a, b) => b.properties.maxConfidence - a.properties.maxConfidence);
  return { generatedAt: now, newestTs: newestTs || null, vessels: { type: "FeatureCollection", features } };
}

export function vesselCounts(
  states: Iterable<VesselState>, now: number, windowMs: number = CONFIG.snapshotWindowMs,
): Record<RegionId, number> {
  const counts = Object.fromEntries(CONFIG.regions.map((r) => [r.id, 0])) as Record<RegionId, number>;
  for (const s of states) {
    if (s.region !== null && inWindow(s, now, windowMs, "")) counts[s.region]++;
  }
  return counts;
}

export function liveVessel(s: VesselState | undefined): LiveVessel | null {
  if (!s || s.ring.length === 0) return null;
  const lp = s.ring[s.ring.length - 1];
  return {
    mmsi: s.mmsi, name: s.name, callsign: s.callsign,
    lon: lp.lon, lat: lp.lat, sog: lp.sog, cog: lp.cog, lastTs: s.lastSeen,
    region: s.region ?? null, shipType: s.shipType ?? null, destination: s.destination ?? null,
    dimBow: s.dimBow ?? null, dimStern: s.dimStern ?? null, dimPort: s.dimPort ?? null, dimStarboard: s.dimStarboard ?? null,
  };
}
