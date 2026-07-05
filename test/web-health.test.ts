// test/web-health.test.ts
import { describe, expect, it } from "vitest";
import { healthView } from "../web/src/health";

const NOW = 1_800_000_000_000;
const STALE = 5 * 60_000;

describe("healthView", () => {
  it("null newestTs shows ingest-down banner and amber no-data chip", () => {
    const h = healthView(null, 0, NOW, STALE);
    expect(h.bannerHidden).toBe(false);
    expect(h.bannerText).toContain("no vessel data received yet");
    expect(h.chipLive).toBe(false);
    expect(h.chipText).toBe("● no data");
  });

  it("fresh data hides the banner and shows a green live chip with count", () => {
    const h = healthView(NOW - 10_000, 42, NOW, STALE);
    expect(h.bannerHidden).toBe(true);
    expect(h.chipLive).toBe(true);
    expect(h.chipText).toBe("● live — 42 vessels");
  });

  it("stale data shows a time-stamped banner and amber chip", () => {
    const h = healthView(NOW - 10 * 60_000, 7, NOW, STALE);
    expect(h.bannerHidden).toBe(false);
    expect(h.bannerText).toMatch(/^⚠ data stale since \d{2}:\d{2}$/);
    expect(h.chipLive).toBe(false);
    expect(h.chipText).toBe("● stale — 7 vessels");
  });
});
