// src/types.ts
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
}

export interface VesselState {
  mmsi: number;
  name: string | null;
  callsign: string | null;
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
    ring: [], identities: [],
    lastSeen: now,
    loiterStart: null, loiterReported: false,
    gapOpenSince: null, dragReportedTs: null,
    score: 0, scoreTs: now,
  };
}
