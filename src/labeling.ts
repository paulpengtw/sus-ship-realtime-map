// src/labeling.ts — labeling harness types + D1 row converters (spec §3).
import type { ThreatCategory } from "./types";

export const LABEL_SOURCES = ["assessment", "event_cluster", "random_negative", "curated_positive"] as const;
export type LabelSource = (typeof LABEL_SOURCES)[number];

export const LABEL_VERDICTS = ["threat", "suspicious", "benign", "unclear"] as const;
export type LabelVerdict = (typeof LABEL_VERDICTS)[number];

export interface CandidateIncident {
  id: string;
  vesselId: string;
  tStart: number;
  tEnd: number;
  source: LabelSource;
  sourceRef: string | null;
  createdAt: number;
  modelSnapshot: unknown;
  eventIds: string[];
}

export interface IncidentLabel {
  id?: number;
  incidentId: string;
  labeler: string;
  ts: number;
  verdict: LabelVerdict;
  intentCategories: ThreatCategory[] | null;
  labelerConfidence: number | null;
  notes: string | null;
}

export type SourceMaterializer = (deps: {
  origin: string;
  now: number;
  lookbackMs: number;
}) => Promise<CandidateIncident[]>;

// Deterministic 16-hex-char id (double FNV-1a) — sync, works in workers + tsx.
export function candidateIdOf(vesselId: string, tStart: number, tEnd: number, source: LabelSource): string {
  const s = `${vesselId}:${tStart}:${tEnd}:${source}`;
  let h1 = 0x811c9dc5, h2 = 0xdeadbeef;
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619) >>> 0;
    h2 = Math.imul(h2 ^ s.charCodeAt(i), 2246822519) >>> 0;
  }
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).slice(0, 16);
}

export function rowToCandidate(r: any): CandidateIncident {
  return {
    id: r.id,
    vesselId: r.vessel_id,
    tStart: r.t_start,
    tEnd: r.t_end,
    source: r.source,
    sourceRef: r.source_ref ?? null,
    createdAt: r.created_at,
    modelSnapshot: r.model_snapshot != null ? JSON.parse(r.model_snapshot) : null,
    eventIds: r.event_ids != null ? JSON.parse(r.event_ids) : [],
  };
}

export function rowToLabel(r: any): IncidentLabel {
  return {
    id: r.id,
    incidentId: r.incident_id,
    labeler: r.labeler,
    ts: r.ts,
    verdict: r.verdict,
    intentCategories: r.intent_categories != null ? JSON.parse(r.intent_categories) : null,
    labelerConfidence: r.labeler_confidence ?? null,
    notes: r.notes ?? null,
  };
}
