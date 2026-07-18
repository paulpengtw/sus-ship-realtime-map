import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const seedCandidate = (id: string, source: string, createdAt: number) =>
  env.DB.prepare(
    `INSERT INTO candidate_incidents (id, vessel_id, t_start, t_end, source, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  ).bind(id, "416000001", 1, 2, source, createdAt);

const seedLabel = (incidentId: string, verdict: string, labeler = "alice") =>
  env.DB.prepare(
    `INSERT INTO labels (incident_id, labeler, ts, verdict, intent_categories, labeler_confidence, notes)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  ).bind(incidentId, labeler, 1, verdict, null, 3, null);

describe("GET /api/labels/stats", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM labels"),
      env.DB.prepare("DELETE FROM candidate_incidents"),
      seedCandidate("a1", "assessment", 1), seedCandidate("a2", "assessment", 2),
      seedCandidate("e1", "event_cluster", 3), seedCandidate("n1", "random_negative", 4),
      seedLabel("a1", "threat"), seedLabel("a2", "benign"), seedLabel("e1", "unclear"),
    ]);
  });

  it("reports per-source totals + labeled counts and verdict roll-up", async () => {
    const body = await (await SELF.fetch("https://x/api/labels/stats")).json<any>();
    expect(body.bySource.assessment).toEqual({ total: 2, labeled: 2 });
    expect(body.bySource.event_cluster).toEqual({ total: 1, labeled: 1 });
    expect(body.bySource.random_negative).toEqual({ total: 1, labeled: 0 });
    expect(body.bySource.curated_positive).toEqual({ total: 0, labeled: 0 });
    expect(body.byVerdict).toEqual({ threat: 1, suspicious: 0, benign: 1, unclear: 1 });
    expect(body.imbalance.threatVsBenign).toBe(1);
    expect(body.imbalance.benignVsThreat).toBe(1);
  });

  it("does not double-count a candidate with multiple labels", async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM labels"),
      env.DB.prepare("DELETE FROM candidate_incidents"),
      seedCandidate("dup", "assessment", 1),
      seedLabel("dup", "threat", "alice"),
      seedLabel("dup", "benign", "bob"),
    ]);

    const body = await (await SELF.fetch("https://x/api/labels/stats")).json<any>();
    expect(body.bySource.assessment.total).toBe(1);
    expect(body.bySource.assessment.labeled).toBe(1);
    expect(body.byVerdict).toEqual({ threat: 1, suspicious: 0, benign: 1, unclear: 0 });
  });
});
