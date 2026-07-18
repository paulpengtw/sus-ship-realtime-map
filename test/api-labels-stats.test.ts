import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const seedCandidate = (id: string, source: string, createdAt: number) =>
  env.DB.prepare(
    `INSERT INTO candidate_incidents (id, vessel_id, t_start, t_end, source, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  ).bind(id, "416000001", 1, 2, source, createdAt);

const seedLabel = (incidentId: string, verdict: string) =>
  env.DB.prepare(
    `INSERT INTO labels (incident_id, labeler, ts, verdict, intent_categories, labeler_confidence, notes)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  ).bind(incidentId, "alice", 1, verdict, null, 3, null);

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
  });
});
