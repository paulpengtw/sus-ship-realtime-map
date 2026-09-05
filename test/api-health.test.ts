// test/api-health.test.ts — /api/health proxies the DO's side-effect-free status.
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import { seedTracker, vesselAt } from "./helpers/tracker";

describe("/api/health", () => {
  it("reports connection state and in-memory vessel count", async () => {
    await seedTracker([vesselAt(1, 120, 22, Date.now()), vesselAt(2, 121, 23, Date.now())]);
    const res = await SELF.fetch("https://x/api/health");
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.generatedAt).toBeGreaterThan(0);
    expect(body.connected).toBe(false);
    expect(body.vessels).toBe(2);
    expect(body.writes).toMatchObject({ budget: CONFIG.d1DailyWriteBudget, optionalWritesPaused: false });
    expect(body.writes.usedToday).toBeGreaterThanOrEqual(0);
  });
});
