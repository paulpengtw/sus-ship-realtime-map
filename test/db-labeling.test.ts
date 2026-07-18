import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("labeling schema (migration 0006)", () => {
  it("candidate_incidents accepts all four source values with a hashed id", async () => {
    await env.DB.prepare(
      `INSERT INTO candidate_incidents (id, vessel_id, t_start, t_end, source, source_ref, created_at, model_snapshot, event_ids)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    ).bind("hash1", "416000001", 1_700_000_000_000, 1_700_003_600_000, "assessment", "cable_interference-1-1", 1_700_004_000_000, "{}", "[]").run();
    const row = await env.DB.prepare(`SELECT * FROM candidate_incidents WHERE id = ?1`).bind("hash1").first<any>();
    expect(row).toMatchObject({ vessel_id: "416000001", source: "assessment", source_ref: "cable_interference-1-1" });
  });

  it("labels enforces one label per (incident_id, labeler)", async () => {
    await env.DB.prepare(
      `INSERT INTO candidate_incidents (id, vessel_id, t_start, t_end, source, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind("hash2", "416000002", 1_700_000_000_000, 1_700_003_600_000, "random_negative", 1_700_004_000_000).run();
    await env.DB.prepare(
      `INSERT INTO labels (incident_id, labeler, ts, verdict, intent_categories, labeler_confidence, notes)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    ).bind("hash2", "alice", 1_700_005_000_000, "benign", null, 4, "").run();
    await expect(
      env.DB.prepare(
        `INSERT INTO labels (incident_id, labeler, ts, verdict, intent_categories, labeler_confidence, notes)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      ).bind("hash2", "alice", 1_700_005_600_000, "threat", '["cable_interference"]', 5, "changed my mind").run(),
    ).rejects.toThrow(/UNIQUE/i);
  });
});
