// src/materialize-server.ts — pure candidate builders per LabelSource (spec §3b).
import { candidateIdOf, type CandidateIncident } from "./labeling";
import { windowsOverlap, type Window } from "./materializer";

export interface AssessmentRow {
  id: string; mmsi: number; opened_ts: number; closed_ts: number | null;
  category: string; confidence: number; region: string | null;
}

export function candidatesFromAssessments(rows: AssessmentRow[], marginMs: number, now: number): CandidateIncident[] {
  return rows.map((r) => {
    const tStart = r.opened_ts - marginMs;
    const tEnd = (r.closed_ts ?? now) + marginMs;
    return {
      id: candidateIdOf(String(r.mmsi), tStart, tEnd, "assessment"),
      vesselId: String(r.mmsi),
      tStart, tEnd,
      source: "assessment",
      sourceRef: r.id,
      createdAt: now,
      modelSnapshot: {
        assessmentId: r.id, category: r.category, confidence: r.confidence,
        openedTs: r.opened_ts, closedTs: r.closed_ts, region: r.region,
      },
      eventIds: [],
    };
  });
}

export interface EventRow { id: string; mmsi: number; start_ts: number; type: string; }

export function candidatesFromEventClusters(
  events: EventRow[], assessmentWindows: Window[], bucketMs: number, minEvents: number, now: number,
): CandidateIncident[] {
  const buckets = new Map<string, EventRow[]>();
  for (const e of events) {
    const bucketStart = Math.floor(e.start_ts / bucketMs) * bucketMs;
    const key = `${e.mmsi}:${bucketStart}`;
    (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(e);
  }
  const out: CandidateIncident[] = [];
  for (const [key, group] of buckets) {
    if (group.length < minEvents) continue;
    const bucketStart = Number(key.split(":")[1]);
    const w: Window = { tStart: bucketStart, tEnd: bucketStart + bucketMs };
    if (assessmentWindows.some((a) => windowsOverlap(w, a))) continue;
    const vesselId = String(group[0].mmsi);
    out.push({
      id: candidateIdOf(vesselId, w.tStart, w.tEnd, "event_cluster"),
      vesselId, tStart: w.tStart, tEnd: w.tEnd,
      source: "event_cluster", sourceRef: key, createdAt: now,
      modelSnapshot: { types: [...new Set(group.map((e) => e.type))] },
      eventIds: group.map((e) => e.id),
    });
  }
  return out;
}

const DAY_MS = 86_400_000;

function stableHash(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
}

export function candidatesFromRandomNegatives(
  vesselDays: { vessel_id: string; day_ms: number }[],
  skipWindows: Window[],
  samplesPerDay: number,
  seed: string,
  now: number,
): CandidateIncident[] {
  const byDay = new Map<number, { vessel_id: string; day_ms: number }[]>();
  for (const v of vesselDays) {
    (byDay.get(v.day_ms) ?? byDay.set(v.day_ms, []).get(v.day_ms)!).push(v);
  }
  const out: CandidateIncident[] = [];
  for (const [day, group] of byDay) {
    const w: Window = { tStart: day, tEnd: day + DAY_MS };
    if (skipWindows.some((s) => windowsOverlap(w, s))) continue;
    const scored = group.map((v) => ({ v, s: stableHash(`${v.vessel_id}:${day}:${seed}`) }));
    scored.sort((a, b) => a.s - b.s);
    for (const { v } of scored.slice(0, samplesPerDay)) {
      out.push({
        id: candidateIdOf(v.vessel_id, w.tStart, w.tEnd, "random_negative"),
        vesselId: v.vessel_id,
        tStart: w.tStart, tEnd: w.tEnd,
        source: "random_negative",
        sourceRef: null, createdAt: now,
        modelSnapshot: {}, eventIds: [],
      });
    }
  }
  return out;
}

export interface CuratedEntry { mmsi: number; tStart: number; tEnd: number; note: string; }

export function candidatesFromCuratedPositives(entries: CuratedEntry[], now: number): CandidateIncident[] {
  return entries.map((e) => {
    const vesselId = String(e.mmsi);
    return {
      id: candidateIdOf(vesselId, e.tStart, e.tEnd, "curated_positive"),
      vesselId, tStart: e.tStart, tEnd: e.tEnd,
      source: "curated_positive",
      sourceRef: e.note, createdAt: now,
      modelSnapshot: { note: e.note }, eventIds: [],
    };
  });
}
