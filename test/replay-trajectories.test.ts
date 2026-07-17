// test/replay-trajectories.test.ts — spec §5: replayed capture produces plausible trajectory lines.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { parseAisStreamMessage } from "../src/aisstream";
import { GeoContext } from "../src/geo/context";
import { replayCapture } from "../src/replay-core";
import capture from "./fixtures/capture.ndjson?raw";

describe("replayed capture → /api/trajectories", () => {
  it("draws the loiterer's line and nothing for the calm vessel", async () => {
    const lines = capture.trim().split("\n");
    const positions = lines
      .map((l) => parseAisStreamMessage(JSON.parse(l)))
      .flatMap((p) => (p?.pos ? [p.pos] : []));
    const { events } = replayCapture(lines, new GeoContext());
    const loiter = events.find((e) => e.type === "loitering" && e.endTs === null)!;
    expect(loiter).toBeDefined();
    // Rebase the capture's fixed timestamps so the newest point is "now" (the capture spans
    // only a few hours, so the shifted open event stays inside the 24 h open-event rule).
    const shift = Date.now() - Math.max(...positions.map((p) => p.ts));

    const stmts = [
      env.DB.prepare("DELETE FROM vessels"), env.DB.prepare("DELETE FROM positions"), env.DB.prepare("DELETE FROM events"),
      env.DB.prepare("DELETE FROM assessments"),
      env.DB.prepare(`INSERT INTO assessments (id, mmsi, category, status, confidence, opened_ts, updated_ts, closed_ts, region, narrative, evidence)
                      VALUES (?1, ?2, 'cable_interference', 'open', 0.45, ?3, ?3, NULL, ?4, 'Loitering over corridor.', '[]')`)
        .bind(`cable_interference-${loiter.mmsi}-1`, loiter.mmsi, loiter.startTs + shift, loiter.region ?? null),
    ];
    const seen = new Set<number>();
    for (const p of positions) {
      stmts.push(env.DB.prepare(`INSERT OR REPLACE INTO positions VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
        .bind(p.mmsi, p.ts + shift, p.lon, p.lat, p.sog, p.cog));
      if (!seen.has(p.mmsi)) {
        seen.add(p.mmsi);
        stmts.push(env.DB.prepare(
          `INSERT OR REPLACE INTO vessels (mmsi, name, callsign, last_lon, last_lat, last_sog, last_cog, last_ts, score, score_ts)
           VALUES (?1, NULL, NULL, ?2, ?3, ?4, ?5, ?6, 0, ?6)`,
        ).bind(p.mmsi, p.lon, p.lat, p.sog, p.cog, p.ts + shift));
      }
    }
    await env.DB.batch(stmts);

    const body = await (await SELF.fetch("https://x/api/trajectories?window=week")).json<any>();
    expect(body.trajectories).toHaveLength(1); // calm 999000002 must not appear
    const t = body.trajectories[0];
    expect(t.mmsi).toBe(loiter.mmsi);
    expect(t.topCategory).toBe("cable_interference");
    expect(t.points).toHaveLength(positions.filter((p) => p.mmsi === loiter.mmsi).length);
    const ts = t.points.map((p: number[]) => p[2]);
    expect(ts).toEqual([...ts].sort((a: number, b: number) => a - b));
  });
});
