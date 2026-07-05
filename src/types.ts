// src/types.ts
import type { RegionId } from "./config";
export interface AisPosition {
  mmsi: number;
  lon: number;
  lat: number;
  sog: number;
  cog: number;
  heading: number | null;
  ts: number;
}

export interface AisIdentity {
  mmsi: number;
  name: string;
  callsign: string;
  ts: number;
  shipType?: number | null;
  destination?: string | null;
  dimBow?: number | null;
  dimStern?: number | null;
  dimPort?: number | null;
  dimStarboard?: number | null;
}

export type EventType = "loitering" | "ais_gap" | "identity" | "anchor_drag";
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
  dragReportedTs: number | null;
  score: number;
  scoreTs: number;
}

export function newVesselState(mmsi: number, now: number): VesselState {
  return {
    mmsi, name: null, callsign: null,
    region: null, shipType: null, destination: null,
    dimBow: null, dimStern: null, dimPort: null, dimStarboard: null,
    ring: [], identities: [],
    lastSeen: now,
    loiterStart: null, loiterReported: false,
    gapOpenSince: null, dragReportedTs: null,
    score: 0, scoreTs: now,
  };
}
