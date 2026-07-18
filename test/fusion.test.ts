// test/fusion.test.ts
import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import { GeoContext } from "../src/geo/context";
import { newVesselState, type AnomalyEvent } from "../src/types";
import { applyEventToFusion, clauseFor, confidenceFor, maxCategoryScore, signalsFor } from "../src/fusion";

const cables = { type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "C1", approximate: true }, geometry: { type: "LineString", coordinates: [[120.0, 22.0], [121.0, 22.0]] } }] };
const noFc = { type: "FeatureCollection", features: [] };
const geo = new GeoContext(cables as any, noFc as any, 1000, noFc as any, 5000);
const T0 = 1_750_000_000_000;

const ev = (over: Partial<AnomalyEvent>): AnomalyEvent => ({
  id: "x", type: "loitering", severity: 3, mmsi: 1, lon: 120.2, lat: 22.0,
  startTs: T0, endTs: T0, evidence: {}, region: "tw", ...over,
});

const loiterEv = (idSuffix = "1") => ev({ id: `loitering-1-${idSuffix}`, type: "loitering", evidence: { corridor: "C1", durationMs: 3 * 3_600_000 } });
const darkGapEv = () => ev({ id: "ais_gap-1-1", type: "ais_gap", endTs: T0 + 2 * 3_600_000, evidence: { gapMs: 2 * 3_600_000, distanceM: 15_000, impliedSpeedKn: 4, startInCorridor: true, endInCorridor: false } });
const flagEv = (n: number) => ev({ id: `identity-1-${n}-flag`, type: "identity", evidence: { kind: "flag_mismatch", midCountry: "CN", callsignCountry: "TW", callsign: "BV1" } });

describe("signal mapping", () => {
  // This fixture exercises the branch-selection difference: old clauseFor preferred any present name, while new logic checks whether the name changed.
  it("clauseFor identity_change: falls back to callsign when only callsign changed", () => {
    const ev = { type: "identity", evidence: { kind: "identity_change", prevName: "SHUNXIN 39", newName: "SHUNXIN 39", prevCallsign: "X1", newCallsign: "X2" } } as any;
    expect(clauseFor(ev)).toBe("identity changed (X1 → X2)");
  });

  it("anchor drag is a strong cable signal", () => {
    const s = newVesselState(1, T0);
    const sig = signalsFor(ev({ type: "anchor_drag", evidence: { corridor: "C1", cogStdDeg: 80, meanSogKn: 1.2 } }), s, geo, CONFIG);
    expect(sig).toEqual([expect.objectContaining({ category: "cable_interference", cls: "strong" })]);
  });

  it("a dark gap in-corridor with repositioning maps to cable AND dark, one weight each (max rule)", () => {
    const s = newVesselState(1, T0);
    const sig = signalsFor(darkGapEv(), s, geo, CONFIG);
    const cats = sig.map((x) => x.category).sort();
    expect(cats).toEqual(["cable_interference", "dark_activity"]);
    expect(sig.every((x) => x.cls === "medium")).toBe(true); // corridor+reposition does NOT sum
  });

  it("an open gap event (endTs null) produces no signals", () => {
    const s = newVesselState(1, T0);
    expect(signalsFor(ev({ type: "ais_gap", endTs: null, evidence: {} }), s, geo, CONFIG)).toEqual([]);
  });

  it("route/speed anomalies outside the corridor produce no signals", () => {
    const s = newVesselState(1, T0);
    expect(signalsFor(ev({ type: "route_deviation", lon: 120.2, lat: 23.9, evidence: { kind: "circling" } }), s, geo, CONFIG)).toEqual([]);
  });
});

describe("fusion scoring and assessment lifecycle (open/update)", () => {
  it("one medium signal does not open; a second independent type does", () => {
    const s = newVesselState(1, T0);
    expect(applyEventToFusion(s, loiterEv(), geo, CONFIG, T0)).toEqual([]); // 0.45 < 0.6
    expect(s.assessments.cable_interference).toBeUndefined();
    const changed = applyEventToFusion(s, darkGapEv(), geo, CONFIG, T0 + 60_000);
    const cable = changed.find((a) => a.category === "cable_interference")!;
    expect(cable.status).toBe("open");
    expect(cable.evidence).toHaveLength(2); // pre-open loiter evidence is preserved
    expect(cable.confidence).toBeCloseTo(confidenceFor(0.9), 1);
    // dark_activity got a single medium — must NOT open
    expect(s.assessments.dark_activity).toBeUndefined();
    expect(s.categories.dark_activity.score).toBeCloseTo(0.45, 2);
  });

  it("a strong signal opens alone", () => {
    const s = newVesselState(2, T0);
    const changed = applyEventToFusion(s, ev({ type: "anchor_drag", id: "anchor_drag-2-1", evidence: { corridor: "C1", cogStdDeg: 80, meanSogKn: 1.2 } }), geo, CONFIG, T0);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ category: "cable_interference", status: "open", mmsi: 2 });
    expect(changed[0].id).toBe(`cable_interference-2-${T0}`);
  });

  it("repeated weak signals are damped and can never open", () => {
    const s = newVesselState(3, T0);
    for (let i = 0; i < 6; i++) applyEventToFusion(s, flagEv(i), geo, CONFIG, T0 + i * 60_000);
    // 0.15 + 5 × 0.0375 = 0.3375 < 0.6
    expect(s.assessments.identity_deception).toBeUndefined();
    expect(s.categories.identity_deception.score).toBeLessThan(CONFIG.assessmentOpenScore);
  });

  it("same eventId re-applied (loiter close) updates the existing evidence ref, not a duplicate", () => {
    const s = newVesselState(4, T0);
    applyEventToFusion(s, ev({ type: "anchor_drag", id: "anchor_drag-4-1", evidence: { corridor: "C1" } }), geo, CONFIG, T0);
    applyEventToFusion(s, loiterEv("open"), geo, CONFIG, T0 + 1_000);
    const before = s.assessments.cable_interference!.evidence.length;
    applyEventToFusion(s, loiterEv("open"), geo, CONFIG, T0 + 2_000); // same id again (close)
    expect(s.assessments.cable_interference!.evidence).toHaveLength(before);
  });

  it("a re-emitted loitering event (open then close, same id) contributes score only once", () => {
    const s = newVesselState(7, T0);
    applyEventToFusion(s, loiterEv("dup"), geo, CONFIG, T0); // open
    const scoreAfterFirst = s.categories.cable_interference.score;
    applyEventToFusion(s, loiterEv("dup"), geo, CONFIG, T0); // close, same event id, same instant
    expect(s.categories.cable_interference.score).toBeCloseTo(scoreAfterFirst, 5);
    expect(s.categories.cable_interference.score).toBeCloseTo(0.45, 2);
    expect(s.categories.cable_interference.recent).toHaveLength(1);
    expect(s.categories.cable_interference.recent[0].weight).toBeCloseTo(0.45, 2);
  });

  it("score decays with the configured half-life between contributions", () => {
    // NOTE: decay is applied lazily, at contribution time — so the second event must
    // touch the SAME category to observe the decay in the stored score.
    const s = newVesselState(5, T0);
    applyEventToFusion(s, loiterEv(), geo, CONFIG, T0);
    applyEventToFusion(s, ev({ type: "speed_anomaly", id: "speed_anomaly-5-1", evidence: { kind: "type_mismatch" } }), geo, CONFIG, T0 + CONFIG.scoreHalfLifeMs);
    // cable: 0.45 halved to 0.225, plus weak in-corridor speed signal 0.15 = 0.375
    expect(s.categories.cable_interference.score).toBeCloseTo(0.375, 2);
  });

  it("maxCategoryScore returns the hottest category for the legacy vessels.score column", () => {
    const s = newVesselState(6, T0);
    applyEventToFusion(s, loiterEv(), geo, CONFIG, T0);
    expect(maxCategoryScore(s).score).toBeCloseTo(0.45, 2);
  });
});
