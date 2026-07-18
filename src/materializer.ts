// src/materializer.ts — shared helpers for the candidate-incident materializer (spec §3b).
import type { CandidateIncident } from "./labeling";

export type Window = { tStart: number; tEnd: number };

export function windowsOverlap(a: Window, b: Window): boolean {
  return a.tStart < b.tEnd && b.tStart < a.tEnd;
}

export const SHARED_INSERT_SQL =
  `INSERT OR IGNORE INTO candidate_incidents
   (id, vessel_id, t_start, t_end, source, source_ref, created_at, model_snapshot, event_ids)
   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`;

export function toInsertRow(c: CandidateIncident): [string, string, number, number, string, string | null, number, string, string] {
  return [
    c.id, c.vesselId, c.tStart, c.tEnd, c.source, c.sourceRef, c.createdAt,
    JSON.stringify(c.modelSnapshot ?? {}),
    JSON.stringify(c.eventIds ?? []),
  ];
}
