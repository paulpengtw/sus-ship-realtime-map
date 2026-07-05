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

// On-demand deep-history backfill (trajectories spec §1). Dataset ids follow the same
// convention as GFW_DATASETS above — verify against GFW v3 docs if the API ever 404s them.
export const GFW_BACKFILL_DATASETS = [
  "public-global-gaps-events:latest",
  "public-global-loitering-events:latest",
  "public-global-encounters-events:latest",
  "public-global-port-visits-events:latest",
  "public-global-fishing-events:latest",
];
const GFW_VESSEL_SEARCH_URL = "https://gateway.api.globalfishingwatch.org/v3/vessels/search";
const GFW_BACKFILL_TTL_MS = 24 * 3_600_000;
const GFW_BACKFILL_RANGE_MS = 180 * 86_400_000;

// Two-step: Vessels API search by ssvid (MMSI) → Events query by GFW vessel id.
// Success and vessel-unknown are cached for 24 h; API errors are NOT cached so the next
// request retries (spec §4).
export async function gfwBackfillVessel(env: Env, mmsi: number, now: number, fetchImpl: typeof fetch = fetch): Promise<{ error: boolean }> {
  const cached = await env.DB.prepare(`SELECT gfw_id, fetched_ts FROM gfw_backfill WHERE mmsi = ?1`).bind(mmsi).first<any>();
  if (cached && now - cached.fetched_ts < GFW_BACKFILL_TTL_MS) return { error: false };
  try {
    const sres = await fetchImpl(
      `${GFW_VESSEL_SEARCH_URL}?query=${mmsi}&datasets[0]=public-global-vessel-identity:latest`,
      { headers: { Authorization: `Bearer ${env.GFW_TOKEN}` } },
    );
    if (!sres.ok) throw new Error(`GFW vessel search ${sres.status}`);
    const sdata = await sres.json<any>();
    const gfwId: string | null = sdata.entries?.[0]?.selfReportedInfo?.[0]?.id ?? null;
    if (gfwId === null) {
      await env.DB.prepare(`INSERT OR REPLACE INTO gfw_backfill (mmsi, gfw_id, fetched_ts) VALUES (?1, NULL, ?2)`).bind(mmsi, now).run();
      return { error: false };
    }
    const eres = await fetchImpl(GFW_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.GFW_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        datasets: GFW_BACKFILL_DATASETS,
        vessels: [gfwId],
        startDate: new Date(now - GFW_BACKFILL_RANGE_MS).toISOString().slice(0, 10),
        endDate: new Date(now).toISOString().slice(0, 10),
      }),
    });
    if (!eres.ok) throw new Error(`GFW events ${eres.status}`);
    const edata = await eres.json<any>();
    const entries: any[] = edata.entries ?? [];
    const stmts = entries
      .filter((e) => e.id && e.position && Number.isFinite(e.position.lon) && Number.isFinite(e.position.lat))
      .map((e) => env.DB.prepare(
        `INSERT OR REPLACE INTO gfw_events (id, type, mmsi, lon, lat, start_ts, end_ts, raw) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      ).bind(String(e.id), String(e.type ?? "unknown"), mmsi, e.position.lon, e.position.lat,
             Date.parse(e.start), e.end ? Date.parse(e.end) : null, JSON.stringify(e)));
    stmts.push(env.DB.prepare(`INSERT OR REPLACE INTO gfw_backfill (mmsi, gfw_id, fetched_ts) VALUES (?1, ?2, ?3)`).bind(mmsi, gfwId, now));
    stmts.push(env.DB.prepare(`UPDATE vessels SET gfw_id = ?2 WHERE mmsi = ?1`).bind(mmsi, gfwId));
    await env.DB.batch(stmts);
    return { error: false };
  } catch (err) {
    console.error(`gfw backfill mmsi=${mmsi} failed:`, err);
    return { error: true };
  }
}
