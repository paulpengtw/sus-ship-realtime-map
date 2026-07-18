import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const seedCandidate = (id: string, source: string, createdAt: number) =>
  env.DB.prepare(
    `INSERT INTO candidate_incidents (id, vessel_id, t_start, t_end, source, source_ref, created_at, model_snapshot, event_ids)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  ).bind(id, "416000001", 1, 2, source, null, createdAt, "{}", "[]");

const seedLabel = (incidentId: string) =>
  env.DB.prepare(
    `INSERT INTO labels (incident_id, labeler, ts, verdict, intent_categories, labeler_confidence, notes)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  ).bind(incidentId, "alice", 1_700_000_000_000, "benign", null, 3, null);

describe("GET /api/labels/queue", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM labels"),
      env.DB.prepare("DELETE FROM candidate_incidents"),
      seedCandidate("a-open", "assessment", 100),
      seedCandidate("a-labeled", "assessment", 200),
      seedLabel("a-labeled"),
      seedCandidate("neg-1", "random_negative", 150),
    ]);
  });

  it("returns only unlabeled candidates, newest first", async () => {
    const res = await SELF.fetch("https://x/api/labels/queue");
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    const ids = body.candidates.map((c: any) => c.id);
    expect(ids).not.toContain("a-labeled");
    expect(ids[0]).toBe("neg-1");
    expect(ids[1]).toBe("a-open");
  });

  it("filters by source and clamps limit", async () => {
    const res = await SELF.fetch("https://x/api/labels/queue?source=random_negative&limit=1");
    const body = await res.json<any>();
    expect(body.candidates.map((c: any) => c.id)).toEqual(["neg-1"]);
  });

  it("rejects unknown source", async () => {
    const res = await SELF.fetch("https://x/api/labels/queue?source=nope");
    expect(res.status).toBe(400);
  });
});
