// src/gfw.ts — daily corroboration pull from Global Fishing Watch v3 events API.
import { CONFIG } from "./config";
import type { Env } from "./worker";

// Verify against GFW docs when registering for a token; only these constants should need editing.
export const GFW_DATASETS = [
  "public-global-gaps-events:latest",
  "public-global-loitering-events:latest",
];
const GFW_URL = "https://gateway.api.globalfishingwatch.org/v3/events?limit=500&offset=0";

export async function gfwSync(env: Env, now: number, fetchImpl: typeof fetch = fetch): Promise<number> {
  const b = CONFIG.regions.reduce((acc, r) => ({
    minLon: Math.min(acc.minLon, r.bbox.minLon),
    minLat: Math.min(acc.minLat, r.bbox.minLat),
    maxLon: Math.max(acc.maxLon, r.bbox.maxLon),
    maxLat: Math.max(acc.maxLat, r.bbox.maxLat),
  }), CONFIG.regions[0].bbox);
  const res = await fetchImpl(GFW_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.GFW_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      datasets: GFW_DATASETS,
      startDate: new Date(now - 7 * 24 * 3_600_000).toISOString().slice(0, 10),
      endDate: new Date(now).toISOString().slice(0, 10),
      geometry: {
        type: "Polygon",
        coordinates: [[[b.minLon, b.minLat], [b.maxLon, b.minLat], [b.maxLon, b.maxLat], [b.minLon, b.maxLat], [b.minLon, b.minLat]]],
      },
    }),
  });
  if (!res.ok) throw new Error(`GFW API ${res.status}: ${await res.text()}`);
  const data = await res.json<any>();
  const entries: any[] = data.entries ?? [];

  const stmts = entries
    .filter((e) => e.id && e.position && Number.isFinite(e.position.lon) && Number.isFinite(e.position.lat))
    .map((e) => env.DB.prepare(
      `INSERT OR REPLACE INTO gfw_events (id, type, mmsi, lon, lat, start_ts, end_ts, raw) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    ).bind(
      String(e.id), String(e.type ?? "unknown"),
      e.vessel?.ssvid ? Number(e.vessel.ssvid) : null,
      e.position.lon, e.position.lat,
      Date.parse(e.start), e.end ? Date.parse(e.end) : null,
      JSON.stringify(e),
    ));
  if (stmts.length) await env.DB.batch(stmts);
  return stmts.length;
}
