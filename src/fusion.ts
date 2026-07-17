// src/fusion.ts — evidence fusion (spec §4): raw events → weighted category signals →
// ThreatAssessment lifecycle. Deterministic: same events in, same assessments out.
import { lastActivity } from "./activity";
import type { Config } from "./config";
import type { GeoContext } from "./geo/context";
import { decayedScore } from "./score";
import { THREAT_CATEGORIES, type AnomalyEvent, type CategoryState, type EvidenceRef, type ThreatAssessment, type ThreatCategory, type VesselState } from "./types";

export type SignalClass = "strong" | "medium" | "weak";
const CLASS_WEIGHT: Record<SignalClass, number> = { strong: 1.0, medium: 0.45, weak: 0.15 };
const DAMPING = 0.25;         // repeat (type,kind) within one half-life contributes 25%
const RECENT_CAP = 10;        // pre-open evidence kept per category

export function confidenceFor(score: number): number {
  return Math.round(Math.min(1, score / 2) * 100) / 100;
}

const fmtH = (ms: number) => `${(ms / 3_600_000).toFixed(1)} h`;
const fmtNm = (m: number) => `${(m / 1852).toFixed(1)} nm`;
const ge = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

// One human-readable clause per event; assessments join these into the narrative (spec §4e).
function clauseFor(ev: AnomalyEvent): string {
  const e = ev.evidence as Record<string, unknown>;
  switch (ev.type) {
    case "loitering":
      return `loitered ${fmtH(ge(e.durationMs))} over ${String(e.corridor ?? "cable")} corridor`;
    case "anchor_drag":
      return `dragged anchor across ${String(e.corridor ?? "cable")} corridor (COG σ ${ge(e.cogStdDeg)}°)`;
    case "ais_gap": {
      let c = `went dark ${fmtH(ge(e.gapMs))}`;
      if (ge(e.distanceM) > 0) c += ` and reappeared ${fmtNm(ge(e.distanceM))} away`;
      if (e.startInCorridor || e.endInCorridor) c += " near a cable corridor";
      return c;
    }
    case "identity":
      if (e.kind === "teleport") return `position jump implies ${ge(e.impliedSpeedKn)} kn`;
      if (e.kind === "flag_mismatch") return `callsign country (${String(e.callsignCountry)}) conflicts with MMSI flag (${String(e.midCountry)})`;
      return `identity changed (${String(e.prevName ?? e.prevCallsign)} → ${String(e.newName ?? e.newCallsign)})`;
    case "speed_anomaly":
      return `speed anomaly (${String(e.kind)}) in corridor`;
    case "route_deviation":
      return `route anomaly (${String(e.kind)}) in corridor`;
  }
}

// Spec §4b weight table. Returns at most one signal per category (max matching class).
export function signalsFor(ev: AnomalyEvent, s: VesselState, geo: GeoContext, cfg: Config): { category: ThreatCategory; cls: SignalClass; summary: string }[] {
  const hits = new Map<ThreatCategory, SignalClass>();
  const raise = (cat: ThreatCategory, cls: SignalClass) => {
    const cur = hits.get(cat);
    if (!cur || CLASS_WEIGHT[cls] > CLASS_WEIGHT[cur]) hits.set(cat, cls);
  };
  const e = ev.evidence as Record<string, unknown>;

  switch (ev.type) {
    case "anchor_drag":
      raise("cable_interference", "strong");
      break;
    case "loitering":
      raise("cable_interference", "medium");
      break;
    case "ais_gap": {
      if (ev.endTs === null) break; // open gap: attributes unknown, telemetry only
      if (e.startInCorridor === true || e.endInCorridor === true) {
        raise("cable_interference", "medium");
        raise("dark_activity", "medium");
      }
      if (ge(e.distanceM) > cfg.darkRepositionMinM) raise("dark_activity", "medium");
      if (ge(e.impliedSpeedKn) > cfg.impossibleSpeedKn) raise("dark_activity", "medium");
      break;
    }
    case "identity": {
      if (e.kind === "teleport") raise("dark_activity", "medium");
      else if (e.kind === "flag_mismatch") raise("identity_deception", "weak");
      else if (e.kind === "identity_change") {
        const act = lastActivity(s, geo, cfg);
        raise("identity_deception", act === "moored" || act === "anchored" ? "weak" : "medium");
      }
      break;
    }
    case "speed_anomaly":
    case "route_deviation":
      if (geo.inCorridor([ev.lon, ev.lat])) raise("cable_interference", "weak");
      break;
  }

  const summary = clauseFor(ev);
  return [...hits].map(([category, cls]) => ({ category, cls, summary }));
}

function narrativeFrom(evidence: EvidenceRef[]): string {
  const clauses = evidence.map((r) => r.summary);
  const joined = clauses.join(", then ");
  return joined ? joined.charAt(0).toUpperCase() + joined.slice(1) + "." : "";
}

function upsertEvidence(list: EvidenceRef[], ref: EvidenceRef): void {
  const i = list.findIndex((r) => r.eventId === ref.eventId);
  if (i >= 0) list[i] = { ...ref, weight: list[i].weight + ref.weight };
  else list.push(ref);
}

export function applyEventToFusion(s: VesselState, ev: AnomalyEvent, geo: GeoContext, cfg: Config, now: number): ThreatAssessment[] {
  const changed: ThreatAssessment[] = [];
  for (const { category, cls, summary } of signalsFor(ev, s, geo, cfg)) {
    const cs: CategoryState = s.categories[category];
    cs.score = decayedScore(cs.score, cs.ts, now, cfg.scoreHalfLifeMs);
    const key = `${ev.type}:${String((ev.evidence as Record<string, unknown>).kind ?? "")}`;
    const damped = cs.contributed[key] !== undefined && now - cs.contributed[key] < cfg.scoreHalfLifeMs;
    const weight = CLASS_WEIGHT[cls] * (damped ? DAMPING : 1);
    cs.score += weight;
    cs.ts = now;
    cs.contributed[key] = now;
    cs.belowSince = null;

    const ref: EvidenceRef = { eventId: ev.id, type: ev.type, kind: ((ev.evidence as Record<string, unknown>).kind as string) ?? null, weight, ts: now, summary };
    let a = s.assessments[category];
    if (!a && cs.score >= cfg.assessmentOpenScore) {
      a = {
        id: `${category}-${s.mmsi}-${now}`, mmsi: s.mmsi, category, status: "open",
        confidence: 0, openedTs: now, updatedTs: now, closedTs: null,
        evidence: [], narrative: "", region: s.region, lastLon: ev.lon, lastLat: ev.lat,
      };
      for (const r of cs.recent) upsertEvidence(a.evidence, r); // pre-open corroborating evidence
      s.assessments[category] = a;
      cs.recent = [];
    }
    if (a) {
      upsertEvidence(a.evidence, ref);
      a.confidence = confidenceFor(cs.score);
      a.narrative = narrativeFrom(a.evidence);
      a.updatedTs = now;
      a.region = s.region ?? a.region;
      a.lastLon = ev.lon;
      a.lastLat = ev.lat;
      changed.push(a);
    } else {
      upsertEvidence(cs.recent, ref);
      cs.recent = cs.recent.filter((r) => now - r.ts < cfg.scoreHalfLifeMs).slice(-RECENT_CAP);
    }
  }
  return changed;
}

export function maxCategoryScore(s: VesselState): { score: number; ts: number } {
  let best = { score: 0, ts: s.lastSeen };
  for (const c of THREAT_CATEGORIES) {
    const cs = s.categories[c];
    if (cs.score > best.score) best = { score: cs.score, ts: cs.ts };
  }
  return best;
}

// Close assessments whose decayed score stayed below the close threshold for the
// configured dwell (spec §4c). Returns the closed assessments for persistence.
export function fusionTick(s: VesselState, cfg: Config, now: number): ThreatAssessment[] {
  const closed: ThreatAssessment[] = [];
  for (const category of THREAT_CATEGORIES) {
    const a = s.assessments[category];
    if (!a) continue;
    const cs = s.categories[category];
    const current = decayedScore(cs.score, cs.ts, now, cfg.scoreHalfLifeMs);
    if (current >= cfg.assessmentCloseScore) {
      cs.belowSince = null;
      continue;
    }
    if (cs.belowSince === null) {
      cs.belowSince = now;
      continue;
    }
    if (now - cs.belowSince >= cfg.assessmentCloseAfterMs) {
      a.status = "closed";
      a.closedTs = now;
      a.confidence = confidenceFor(current);
      a.updatedTs = now;
      delete s.assessments[category];
      cs.belowSince = null;
      closed.push(a);
    }
  }
  return closed;
}
