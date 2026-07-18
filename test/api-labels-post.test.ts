import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

async function seedCandidate(id: string) {
  await env.DB.prepare(
    `INSERT INTO candidate_incidents (id, vessel_id, t_start, t_end, source, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  ).bind(id, "416000001", 1, 2, "assessment", 100).run();
}

async function postLabel(body: unknown, expectStatus = 201) {
  const res = await SELF.fetch("https://x/api/labels", { method: "POST", body: JSON.stringify(body) });
  expect(res.status).toBe(expectStatus);
  return res;
}

describe("POST /api/labels", () => {
  beforeEach(async () => {
    await env.DB.batch([env.DB.prepare("DELETE FROM labels"), env.DB.prepare("DELETE FROM candidate_incidents")]);
    await seedCandidate("inc-1");
  });

  it("writes a benign label without intent categories", async () => {
    await postLabel({ incidentId: "inc-1", labeler: "alice", verdict: "benign", labelerConfidence: 4 });
    const row = await env.DB.prepare(`SELECT verdict, intent_categories FROM labels WHERE incident_id = ?1`).bind("inc-1").first<any>();
    expect(row).toMatchObject({ verdict: "benign", intent_categories: null });
  });

  it("returns 201 on successful label insert", async () => {
    await seedCandidate("inc-2");
    const res = await postLabel({ incidentId: "inc-2", labeler: "alice", verdict: "benign" });
    expect(res.status).toBe(201);
  });

  it("writes a threat label with intent categories JSON", async () => {
    await postLabel({ incidentId: "inc-1", labeler: "alice", verdict: "threat", intentCategories: ["cable_interference", "dark_activity"], labelerConfidence: 5, notes: "loitering + gap" });
    const row = await env.DB.prepare(`SELECT * FROM labels WHERE incident_id = ?1`).bind("inc-1").first<any>();
    expect(JSON.parse(row.intent_categories)).toEqual(["cable_interference", "dark_activity"]);
  });

  it("rejects threat verdict without intentCategories", async () => {
    await postLabel({ incidentId: "inc-1", labeler: "alice", verdict: "threat" }, 400);
  });

  it("rejects benign verdict with non-empty intentCategories", async () => {
    await postLabel({ incidentId: "inc-1", labeler: "alice", verdict: "benign", intentCategories: ["cable_interference"] }, 400);
  });

  it("returns 409 on duplicate (incidentId, labeler)", async () => {
    await postLabel({ incidentId: "inc-1", labeler: "alice", verdict: "benign" });
    await postLabel({ incidentId: "inc-1", labeler: "alice", verdict: "threat", intentCategories: ["dark_activity"] }, 409);
  });

  it("returns 409 already labeled when the same label is posted twice", async () => {
    await seedCandidate("inc-repeat");
    const body = { incidentId: "inc-repeat", labeler: "alice", verdict: "benign" };
    await postLabel(body);
    const res = await postLabel(body, 409);
    expect(await res.json()).toEqual({ error: "already labeled" });
  });

  it("rejects unknown incidentId with 404", async () => {
    await postLabel({ incidentId: "nope", labeler: "alice", verdict: "benign" }, 404);
  });
});
