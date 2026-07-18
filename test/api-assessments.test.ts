import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const NOW = Date.now();
const H = 3_600_000;

const seedAssessment = (id: string, mmsi: number, category: string, status: string, confidence: number, updatedTs: number, closedTs: number | null, region = "tw") =>
  env.DB.prepare(`INSERT INTO assessments (id, mmsi, category, status, confidence, opened_ts, updated_ts, closed_ts, region, narrative, evidence)
                  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8, 'Loitered 3.0 h over C1 corridor.', '[]')`)
    .bind(id, mmsi, category, status, confidence, updatedTs, closedTs, region);

describe("/api/assessments", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM assessments"), env.DB.prepare("DELETE FROM vessels"),
      seedAssessment("cable_interference-1-1", 416000001, "cable_interference", "open", 0.62, NOW - H, null, "tw"),
      seedAssessment("dark_activity-2-1", 440000002, "dark_activity", "open", 0.3, NOW - 2 * H, null, "kr"),
      seedAssessment("identity_deception-3-1", 416000003, "identity_deception", "closed", 0.1, NOW - 2 * H, NOW - 2 * H, "tw"),
      seedAssessment("cable_interference-4-1", 416000004, "cable_interference", "closed", 0.05, NOW - 40 * 24 * H, NOW - 40 * 24 * H, "tw"),
    ]);
  });

  it("returns open + recently-closed assessments, newest first", async () => {
    const res = await SELF.fetch("https://x/api/assessments?window=week");
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    const ids = body.assessments.map((a: any) => a.id);
    expect(ids).toContain("cable_interference-1-1");
    expect(ids).toContain("identity_deception-3-1"); // closed within window
    expect(ids).not.toContain("cable_interference-4-1"); // closed 40 d ago
    const a = body.assessments.find((x: any) => x.id === "cable_interference-1-1");
    expect(a).toMatchObject({ mmsi: 416000001, category: "cable_interference", status: "open", confidence: 0.62, lastLon: 0, lastLat: 0 });
    expect(a.narrative).toContain("Loitered");
    expect(typeof a.lastLon).toBe("number");
    expect(typeof a.lastLat).toBe("number");
  });

  it("filters by region and validates params", async () => {
    const kr = await (await SELF.fetch("https://x/api/assessments?region=kr&window=week")).json<any>();
    expect(kr.assessments).toHaveLength(1);
    expect(kr.assessments[0].category).toBe("dark_activity");
    expect((await SELF.fetch("https://x/api/assessments?region=zz")).status).toBe(400);
    expect((await SELF.fetch("https://x/api/assessments?window=year")).status).toBe(400);
  });
});
