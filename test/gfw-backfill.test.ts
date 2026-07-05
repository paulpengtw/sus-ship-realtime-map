// test/gfw-backfill.test.ts — mocked two-step backfill: vessels search → events query.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { gfwBackfillVessel } from "../src/gfw";

const NOW = Date.now();
const MMSI = 412000009;

function mockFetch(responses: { search?: unknown; searchStatus?: number; events?: unknown; eventsStatus?: number }) {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const u = String(input);
    calls.push(u);
    if (u.includes("/vessels/search")) {
      return new Response(JSON.stringify(responses.search ?? {}), { status: responses.searchStatus ?? 200 });
    }
    return new Response(JSON.stringify(responses.events ?? {}), { status: responses.eventsStatus ?? 200 });
  }) as typeof fetch;
  return { impl, calls };
}

const SEARCH_HIT = { entries: [{ selfReportedInfo: [{ id: "gfw-vessel-1" }] }] };
const EVENTS = { entries: [
  { id: "bf-1", type: "port_visit", start: new Date(NOW - 100 * 86_400_000).toISOString(), end: null, position: { lon: 121, lat: 23 } },
  { id: "bf-2", type: "gap", start: new Date(NOW - 50 * 86_400_000).toISOString(), end: new Date(NOW - 49 * 86_400_000).toISOString(), position: { lon: 122, lat: 24 } },
] };

describe("gfwBackfillVessel", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM gfw_events"), env.DB.prepare("DELETE FROM gfw_backfill"), env.DB.prepare("DELETE FROM vessels"),
      env.DB.prepare(`INSERT INTO vessels (mmsi, name, callsign, last_lon, last_lat, last_sog, last_cog, last_ts, score, score_ts)
                      VALUES (?1, 'GFW SHIP', NULL, 121, 23, 1, 0, ?2, 0, ?2)`).bind(MMSI, NOW),
    ]);
  });

  it("two-step backfill stores events, cache row, and vessels.gfw_id", async () => {
    const { impl, calls } = mockFetch({ search: SEARCH_HIT, events: EVENTS });
    const r = await gfwBackfillVessel({ ...env, GFW_TOKEN: "tok" } as any, MMSI, NOW, impl);
    expect(r.error).toBe(false);
    expect(calls).toHaveLength(2);
    const evs = await env.DB.prepare("SELECT * FROM gfw_events ORDER BY id").all<any>();
    expect(evs.results).toHaveLength(2);
    expect(evs.results[0]).toMatchObject({ id: "bf-1", type: "port_visit", mmsi: MMSI, lon: 121, lat: 23 });
    expect((await env.DB.prepare("SELECT gfw_id FROM gfw_backfill WHERE mmsi = ?1").bind(MMSI).first<any>()).gfw_id).toBe("gfw-vessel-1");
    expect((await env.DB.prepare("SELECT gfw_id FROM vessels WHERE mmsi = ?1").bind(MMSI).first<any>()).gfw_id).toBe("gfw-vessel-1");
  });

  it("vessel unknown to GFW → negative cache, no refetch within 24 h", async () => {
    const { impl, calls } = mockFetch({ search: { entries: [] } });
    expect((await gfwBackfillVessel({ ...env, GFW_TOKEN: "tok" } as any, MMSI, NOW, impl)).error).toBe(false);
    expect(calls).toHaveLength(1); // search only — no events call
    expect((await env.DB.prepare("SELECT gfw_id FROM gfw_backfill WHERE mmsi = ?1").bind(MMSI).first<any>()).gfw_id).toBeNull();
    expect((await gfwBackfillVessel({ ...env, GFW_TOKEN: "tok" } as any, MMSI, NOW + 60_000, impl)).error).toBe(false);
    expect(calls).toHaveLength(1); // negative cache honored
  });

  it("API error → error: true and NO cache row (retried next request)", async () => {
    const { impl } = mockFetch({ search: SEARCH_HIT, events: { error: "rate limited" }, eventsStatus: 429 });
    expect((await gfwBackfillVessel({ ...env, GFW_TOKEN: "tok" } as any, MMSI, NOW, impl)).error).toBe(true);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM gfw_backfill").first<any>()).n).toBe(0);
  });

  it("fresh cache row skips fetch entirely", async () => {
    await env.DB.prepare(`INSERT INTO gfw_backfill (mmsi, gfw_id, fetched_ts) VALUES (?1, 'gfw-vessel-1', ?2)`).bind(MMSI, NOW - 60_000).run();
    const { impl, calls } = mockFetch({ search: SEARCH_HIT, events: EVENTS });
    expect((await gfwBackfillVessel({ ...env, GFW_TOKEN: "tok" } as any, MMSI, NOW, impl)).error).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("stale cache row (> 24 h) refetches", async () => {
    await env.DB.prepare(`INSERT INTO gfw_backfill (mmsi, gfw_id, fetched_ts) VALUES (?1, 'gfw-vessel-1', ?2)`).bind(MMSI, NOW - 25 * 3_600_000).run();
    const { impl, calls } = mockFetch({ search: SEARCH_HIT, events: EVENTS });
    await gfwBackfillVessel({ ...env, GFW_TOKEN: "tok" } as any, MMSI, NOW, impl);
    expect(calls).toHaveLength(2);
  });
});
