import { describe, expect, it } from "vitest";
import { CATEGORY_COLOR, CATEGORY_LABEL, confidencePct, renderAssessmentItem } from "../web/src/assess";
import type { Assessment } from "../web/src/api";

const a: Assessment = {
  id: "cable_interference-416000001-1", mmsi: 416000001, category: "cable_interference", status: "open",
  confidence: 0.62, openedTs: 1_750_000_000_000, updatedTs: 1_750_000_100_000, closedTs: null,
  evidence: [{ eventId: "loitering-416000001-1", type: "loitering", kind: null, weight: 0.45, ts: 1_750_000_000_000, summary: "loitered 3.2 h over C1 corridor" }],
  narrative: "Loitered 3.2 h over C1 corridor.", region: "tw", lastLon: 120.2, lastLat: 22.0,
};

describe("assessment rendering helpers", () => {
  it("has a label and color for every category", () => {
    for (const c of ["cable_interference", "dark_activity", "identity_deception", "militia_presence"]) {
      expect(CATEGORY_LABEL[c]).toBeTruthy();
      expect(CATEGORY_COLOR[c]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("formats confidence as a percentage", () => {
    expect(confidencePct(0.62)).toBe("62%");
    expect(confidencePct(1)).toBe("100%");
  });

  it("renders a feed item with badge, narrative, mmsi, and data attributes for click-to-fly", () => {
    const html = renderAssessmentItem(a);
    expect(html).toContain("Cable");
    expect(html).toContain("62%");
    expect(html).toContain("Loitered 3.2 h over C1 corridor.");
    expect(html).toContain(`data-mmsi="416000001"`);
    expect(html).toContain(`data-lon="120.2"`);
    expect(html).toContain("ongoing"); // open assessment
  });

  it("escapes category fallback in badge to prevent XSS", () => {
    const malicious: Assessment = {
      ...a,
      category: "<img src=x onerror=alert(1)>",
    };
    const html = renderAssessmentItem(malicious);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});
