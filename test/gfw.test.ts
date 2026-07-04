// test/gfw.test.ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { gfwSync } from "../src/gfw";

const T0 = Date.now();

const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = { url: String(input), ...init };
  expect(req.url).toContain("globalfishingwatch.org");
  expect((init!.headers as any).Authorization).toMatch(/^Bearer /);
  return new Response(JSON.stringify({
    entries: [
      { id: "gfw-abc", type: "gap", start: new Date(T0 - 86_400_000).toISOString(), end: new Date(T0 - 82_800_000).toISOString(),
        position: { lon: 120.4, lat: 22.2 }, vessel: { ssvid: "412000009" } },
      { id: "gfw-def", type: "loitering", start: new Date(T0 - 40_000_000).toISOString(), end: null,
        position: { lon: 121.9, lat: 24.7 }, vessel: {} },
    ],
    nextOffset: null,
  }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

describe("gfwSync", () => {
  beforeEach(async () => { await env.DB.prepare("DELETE FROM gfw_events").run(); });

  it("upserts GFW entries into gfw_events", async () => {
    const n = await gfwSync({ ...env, GFW_TOKEN: "tok" } as any, T0, fakeFetch);
    expect(n).toBe(2);
    const rows = await env.DB.prepare("SELECT * FROM gfw_events ORDER BY id").all<any>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results[0]).toMatchObject({ id: "gfw-abc", type: "gap", mmsi: 412000009, lon: 120.4, lat: 22.2 });
    expect(rows.results[1].mmsi).toBeNull();
    expect(rows.results[1].end_ts).toBeNull();
  });

  it("is idempotent on re-run", async () => {
    await gfwSync({ ...env, GFW_TOKEN: "tok" } as any, T0, fakeFetch);
    await gfwSync({ ...env, GFW_TOKEN: "tok" } as any, T0, fakeFetch);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM gfw_events").first<any>();
    expect(n.n).toBe(2);
  });
});
