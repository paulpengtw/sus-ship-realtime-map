import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  candidatesFromAssessments,
  candidatesFromCuratedPositives,
  candidatesFromEventClusters,
  candidatesFromRandomNegatives,
} from "../src/materialize-server";

describe("candidatesFromAssessments", () => {
  it("emits one candidate per assessment with 30-min margins", () => {
    const now = 1_700_100_000_000;
    const rows = [
      { id: "cable_interference-1-1", mmsi: 416000001, opened_ts: 1_700_000_000_000, closed_ts: 1_700_010_000_000,
        category: "cable_interference", confidence: 0.7, region: "tw" },
      { id: "dark_activity-2-1", mmsi: 440000002, opened_ts: 1_700_050_000_000, closed_ts: null,
        category: "dark_activity", confidence: 0.4, region: "kr" },
    ];
    const cs = candidatesFromAssessments(rows as any, 30 * 60_000, now);
    expect(cs).toHaveLength(2);
    expect(cs[0]).toMatchObject({
      vesselId: "416000001", source: "assessment", sourceRef: "cable_interference-1-1",
      tStart: 1_700_000_000_000 - 30 * 60_000,
      tEnd: 1_700_010_000_000 + 30 * 60_000,
    });
    expect(cs[1].tEnd).toBe(now + 30 * 60_000);
    expect((cs[0].modelSnapshot as any).category).toBe("cable_interference");
    expect(cs[0].id).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("/api/labels/materialize (POST) is idempotent", () => {
  beforeEach(async () => {
    await env.DB.batch([env.DB.prepare("DELETE FROM candidate_incidents")]);
  });

  it("inserts new candidates and ignores duplicates", async () => {
    const c = {
      id: "abcdef0123456789", vesselId: "416000001", tStart: 1, tEnd: 2,
      source: "assessment", sourceRef: "a-1", createdAt: 3, modelSnapshot: {}, eventIds: [],
    };
    const post = async () => (await SELF.fetch("https://x/api/labels/materialize", {
      method: "POST", body: JSON.stringify({ source: "assessment", candidates: [c] }),
    })).json<any>();
    expect((await post()).inserted).toBe(1);
    expect((await post()).inserted).toBe(0);
  });
});

describe("candidatesFromEventClusters", () => {
  const bucket = 30 * 60_000;
  const now = 1_700_100_000_000;
  const rowsOfCluster = (mmsi: number, tBase: number, n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `e${mmsi}-${i}`, mmsi, start_ts: tBase + i * 60_000, type: "loitering" }));

  it("emits a candidate for buckets with ≥ minEvents events", () => {
    const events = rowsOfCluster(416, 1_700_000_000_000, 3);
    const cs = candidatesFromEventClusters(events as any, [], bucket, 3, now);
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ vesselId: "416", source: "event_cluster" });
    expect(cs[0].eventIds).toEqual(["e416-0", "e416-1", "e416-2"]);
    expect(cs[0].tEnd - cs[0].tStart).toBe(bucket);
  });

  it("drops buckets below minEvents", () => {
    const events = rowsOfCluster(416, 1_700_000_000_000, 2);
    expect(candidatesFromEventClusters(events as any, [], bucket, 3, now)).toEqual([]);
  });

  it("drops buckets overlapping an assessment window", () => {
    const events = rowsOfCluster(416, 1_700_000_000_000, 4);
    const assessmentWindow = { tStart: 1_700_000_000_000 - 60_000, tEnd: 1_700_000_000_000 + 3 * 60_000 };
    expect(candidatesFromEventClusters(events as any, [assessmentWindow], bucket, 3, now)).toEqual([]);
  });

  it("does NOT drop adjacent (end == start) buckets", () => {
    const events = rowsOfCluster(416, 1_700_001_000_000, 3);
    const assessment = { tStart: 1_700_001_000_000 - bucket, tEnd: 1_700_001_000_000 };
    expect(candidatesFromEventClusters(events as any, [assessment], bucket, 3, now)).toHaveLength(1);
  });
});

describe("candidatesFromRandomNegatives", () => {
  const DAY_MS = 86_400_000;
  const now = 1_700_100_000_000;

  it("selects up to samplesPerDay per (day_ms) bucket, deterministically", () => {
    const days = Array.from({ length: 10 }, (_, i) => ({ vessel_id: String(400_000_000 + i), day_ms: 1_700_000_000_000 }));
    const a = candidatesFromRandomNegatives(days, [], 10, "seed-x", now);
    const b = candidatesFromRandomNegatives(days, [], 10, "seed-x", now);
    expect(a).toHaveLength(10);
    expect(a.map((c) => c.vesselId)).toEqual(b.map((c) => c.vesselId));
    const c = candidatesFromRandomNegatives(days, [], 10, "seed-a", now);
    expect(a.map((x) => x.vesselId)).not.toEqual(c.map((x) => x.vesselId));
  });

  it("excludes days overlapping skipWindows", () => {
    const day = 1_700_000_000_000;
    const skipWindows = [{ tStart: day + 60_000, tEnd: day + 120_000 }];
    expect(candidatesFromRandomNegatives([{ vessel_id: "416000001", day_ms: day }], skipWindows, 5, "s", now)).toEqual([]);
    expect(candidatesFromRandomNegatives([{ vessel_id: "416000001", day_ms: day + DAY_MS }], skipWindows, 5, "s", now)).toHaveLength(1);
  });
});

describe("candidatesFromCuratedPositives", () => {
  it("emits one candidate per entry with note in model_snapshot", () => {
    const cs = candidatesFromCuratedPositives(
      [{ mmsi: 416000001, tStart: 1, tEnd: 2, note: "c4ads:unmasked-vlcc-1" }],
      100,
    );
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({
      vesselId: "416000001", source: "curated_positive",
      sourceRef: "c4ads:unmasked-vlcc-1",
      modelSnapshot: { note: "c4ads:unmasked-vlcc-1" },
    });
  });
});
