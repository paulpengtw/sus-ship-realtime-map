import { describe, expect, it } from "vitest";
import { candidateIdOf, rowToCandidate, rowToLabel } from "../src/labeling";

describe("candidateIdOf", () => {
  it("is deterministic across calls with identical inputs", () => {
    const a = candidateIdOf("416000001", 1_700_000_000_000, 1_700_003_600_000, "assessment");
    const b = candidateIdOf("416000001", 1_700_000_000_000, 1_700_003_600_000, "assessment");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("distinguishes different sources for the same window", () => {
    const a = candidateIdOf("416000001", 1_700_000_000_000, 1_700_003_600_000, "assessment");
    const b = candidateIdOf("416000001", 1_700_000_000_000, 1_700_003_600_000, "event_cluster");
    expect(a).not.toBe(b);
  });
});

describe("row converters", () => {
  it("rowToCandidate parses JSON columns", () => {
    const row = {
      id: "abc", vessel_id: "416000001", t_start: 1, t_end: 2,
      source: "assessment", source_ref: null, created_at: 3,
      model_snapshot: '{"topCategory":"cable_interference"}',
      event_ids: '["evt-1","evt-2"]',
    };
    expect(rowToCandidate(row)).toEqual({
      id: "abc", vesselId: "416000001", tStart: 1, tEnd: 2,
      source: "assessment", sourceRef: null, createdAt: 3,
      modelSnapshot: { topCategory: "cable_interference" },
      eventIds: ["evt-1", "evt-2"],
    });
  });

  it("rowToLabel handles null intent_categories", () => {
    expect(rowToLabel({ incident_id: "abc", labeler: "alice", ts: 1, verdict: "benign", intent_categories: null, labeler_confidence: 4, notes: "" }))
      .toEqual({ incidentId: "abc", labeler: "alice", ts: 1, verdict: "benign", intentCategories: null, labelerConfidence: 4, notes: "" });
    expect(rowToLabel({ incident_id: "abc", labeler: "alice", ts: 1, verdict: "threat", intent_categories: '["cable_interference"]', labeler_confidence: 5, notes: "why" }))
      .toMatchObject({ intentCategories: ["cable_interference"] });
  });

  it("rowToCandidate rejects empty-string JSON columns", () => {
    const row = {
      id: "aaaa000000000000", vessel_id: "123", t_start: 1, t_end: 2,
      source: "assessment", source_ref: null, created_at: 0,
    };
    expect(() => rowToCandidate({ ...row, model_snapshot: "", event_ids: null })).toThrow(SyntaxError);
    expect(() => rowToCandidate({ ...row, model_snapshot: null, event_ids: "" })).toThrow(SyntaxError);
  });

  it("rowToLabel rejects empty-string intent_categories", () => {
    expect(() => rowToLabel({
      id: 1, incident_id: "aaaa000000000000", labeler: "a", ts: 0,
      verdict: "benign", intent_categories: "", labeler_confidence: null, notes: null,
    })).toThrow(SyntaxError);
  });
});
