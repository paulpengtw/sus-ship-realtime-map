// test/db-assessments.test.ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { flushWrites, loadOpenAssessments, newPendingWrites } from "../src/db";
import { newVesselState, type ThreatAssessment } from "../src/types";

const T0 = 1_750_000_000_000;

const assessment = (over: Partial<ThreatAssessment> = {}): ThreatAssessment => ({
  id: `cable_interference-412000001-${T0}`, mmsi: 412000001, category: "cable_interference",
  status: "open", confidence: 0.45, openedTs: T0, updatedTs: T0, closedTs: null,
  evidence: [{ eventId: "loitering-412000001-1", type: "loitering", kind: null, weight: 0.45, ts: T0, summary: "loitered 3.0 h over C1 corridor" }],
  narrative: "Loitered 3.0 h over C1 corridor.", region: "tw", lastLon: 120.2, lastLat: 22.0, ...over,
});

describe("assessment persistence", () => {
  beforeEach(async () => {
    await env.DB.batch([env.DB.prepare("DELETE FROM assessments"), env.DB.prepare("DELETE FROM vessels")]);
  });

  it("flushWrites upserts assessments; loadOpenAssessments round-trips open ones", async () => {
    const p = newPendingWrites();
    p.assessments.set(assessment().id, assessment());
    await flushWrites(env.DB, p);

    // update in place (confidence bumps, still same id)
    const p2 = newPendingWrites();
    p2.assessments.set(assessment().id, assessment({ confidence: 0.62, updatedTs: T0 + 60_000 }));
    await flushWrites(env.DB, p2);

    const open = await loadOpenAssessments(env.DB);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ id: assessment().id, confidence: 0.62, category: "cable_interference", status: "open" });
    expect(open[0].evidence[0].summary).toContain("loitered");

    // closing removes it from the open set
    const p3 = newPendingWrites();
    p3.assessments.set(assessment().id, assessment({ status: "closed", closedTs: T0 + 100_000 }));
    await flushWrites(env.DB, p3);
    expect(await loadOpenAssessments(env.DB)).toHaveLength(0);
    const row = await env.DB.prepare("SELECT status, closed_ts FROM assessments").first<any>();
    expect(row).toEqual({ status: "closed", closed_ts: T0 + 100_000 });
  });

  it("flushWrites writes legacy vessels.score from the hottest category", async () => {
    const p = newPendingWrites();
    const s = newVesselState(412000001, T0);
    s.categories.cable_interference.score = 0.9;
    s.categories.cable_interference.ts = T0;
    s.ring.push({ mmsi: 412000001, lon: 120.2, lat: 22.0, sog: 0.5, cog: 90, heading: 90, ts: T0 });
    s.lastSeen = T0;
    p.vessels.set(s.mmsi, s);
    await flushWrites(env.DB, p);
    const v = await env.DB.prepare("SELECT score, score_ts FROM vessels WHERE mmsi = 412000001").first<any>();
    expect(v.score).toBeCloseTo(0.9);
    expect(v.score_ts).toBe(T0);
  });
});
