// src/types.ts
import type { RegionId } from "./config";
export interface AisPosition {
  mmsi: number;
  lon: number;
  lat: number;
  sog: number;
  cog: number;
  heading: number | null;
  navStatus?: number | null; // AIS NavigationalStatus: 0 under way, 1 at anchor, 5 moored; null = unknown
  ts: number;
}

export interface AisIdentity {
  mmsi: number;
  name: string;
  callsign: string;
  shipType: number | null;
  ts: number;
  destination?: string | null;
  dimBow?: number | null;
  dimStern?: number | null;
  dimPort?: number | null;
  dimStarboard?: number | null;
}

export type EventType = "loitering" | "ais_gap" | "identity" | "anchor_drag" | "speed_anomaly" | "route_deviation";
export type Severity = 1 | 2 | 3 | 4 | 5;

export interface AnomalyEvent {
  id: string;
  type: EventType;
  severity: Severity;
  mmsi: number;
  lon: number;
  lat: number;
  startTs: number;
  endTs: number | null;
  evidence: Record<string, unknown>;
  region?: RegionId | null;
}

export const THREAT_CATEGORIES = ["cable_interference", "dark_activity", "identity_deception", "militia_presence"] as const;
export type ThreatCategory = (typeof THREAT_CATEGORIES)[number];
export interface EvidenceRef { eventId: string; type: EventType; kind: string | null; weight: number; ts: number; summary: string }
export interface ThreatAssessment {
  id: string; mmsi: number; category: ThreatCategory; status: "open" | "closed";
  confidence: number; openedTs: number; updatedTs: number; closedTs: number | null;
  evidence: EvidenceRef[]; narrative: string; region: RegionId | null; lastLon: number; lastLat: number;
}
export interface CategoryState { score: number; ts: number; contributed: Record<string, number>; recent: EvidenceRef[]; belowSince: number | null }

export function newCategoryState(now: number): CategoryState {
  return { score: 0, ts: now, contributed: {}, recent: [], belowSince: null };
}

export interface VesselState {
  mmsi: number;
  name: string | null;
  callsign: string | null;
  region: RegionId | null;
  shipType: number | null;
  destination: string | null;
  dimBow: number | null;
  dimStern: number | null;
  dimPort: number | null;
  dimStarboard: number | null;
  ring: AisPosition[];
  identities: AisIdentity[];
  lastSeen: number;
  loiterStart: number | null;
  loiterReported: boolean;
  gapOpenSince: number | null;
  leftCoverage: boolean;
  dragReportedTs: number | null;
  lastSpeedEventTs: number | null;
  lastRouteEventTs: number | null;
  categories: Record<ThreatCategory, CategoryState>;
  assessments: Partial<Record<ThreatCategory, ThreatAssessment>>;
}

export function newVesselState(mmsi: number, now: number): VesselState {
  return {
    mmsi, name: null, callsign: null,
    region: null, shipType: null, destination: null,
    dimBow: null, dimStern: null, dimPort: null, dimStarboard: null,
    ring: [], identities: [],
    lastSeen: now,
    loiterStart: null, loiterReported: false,
    gapOpenSince: null, leftCoverage: false, dragReportedTs: null,
    lastSpeedEventTs: null, lastRouteEventTs: null,
    categories: {
      cable_interference: newCategoryState(now),
      dark_activity: newCategoryState(now),
      identity_deception: newCategoryState(now),
      militia_presence: newCategoryState(now),
    },
    assessments: {},
  };
}
