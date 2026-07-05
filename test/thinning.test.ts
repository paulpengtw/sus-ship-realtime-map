// test/thinning.test.ts — spec §1: tiered thinning keeps one point per bucket per tier, deletes > 180 d.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import { thinPositions } from "../src/db";

const NOW = 1_780_000_000_000;
const H = 3_600_000, D = 24 * H;

const insert = (mmsi: number, ts: number) =>
  env.DB.prepare(`INSERT OR REPLACE INTO positions VALUES (?1, ?2, 120.5, 22.5, 1, 90)`).bind(mmsi, ts).run();
const allTs = async () =>
  (await env.DB.prepare(`SELECT mmsi, ts FROM positions ORDER BY mmsi, ts`).all<any>()).results;

describe("thinPositions", () => {
  beforeEach(async () => { await env.DB.prepare("DELETE FROM positions").run(); });

  it("keeps raw points younger than 48 h untouched", async () => {
    await insert(1, NOW - 1000);
    await insert(1, NOW - 2000);
    await insert(1, NOW - 3000);
    await thinPositions(env.DB, NOW, CONFIG.retentionTiers);
    expect(await allTs()).toHaveLength(3);
  });

  it("keeps the earliest point per 10-min bucket in the 48 h – 30 d tier", async () => {
    const bucketStart = Math.floor((NOW - 3 * D) / 600_000) * 600_000;
    await insert(1, bucketStart + 10_000);
    await insert(1, bucketStart + 20_000);  // same bucket — dropped
    await insert(1, bucketStart + 30_000);  // same bucket — dropped
    await insert(1, bucketStart + 610_000); // next bucket — kept
    await thinPositions(env.DB, NOW, CONFIG.retentionTiers);
    expect((await allTs()).map((r: any) => r.ts)).toEqual([bucketStart + 10_000, bucketStart + 610_000]);
  });

  it("thins per vessel independently — one point per (mmsi, bucket)", async () => {
    const bucketStart = Math.floor((NOW - 3 * D) / 600_000) * 600_000;
    await insert(1, bucketStart + 10_000);
    await insert(2, bucketStart + 20_000); // other vessel, same bucket — kept
    await thinPositions(env.DB, NOW, CONFIG.retentionTiers);
    expect(await allTs()).toHaveLength(2);
  });

  it("thins to hourly buckets in the 30 d – 180 d tier", async () => {
    const bucketStart = Math.floor((NOW - 60 * D) / H) * H;
    await insert(1, bucketStart + 60_000);
    await insert(1, bucketStart + 120_000);    // same hour — dropped
    await insert(1, bucketStart + H + 60_000); // next hour — kept
    await thinPositions(env.DB, NOW, CONFIG.retentionTiers);
    expect((await allTs()).map((r: any) => r.ts)).toEqual([bucketStart + 60_000, bucketStart + H + 60_000]);
  });

  it("deletes points older than 180 d", async () => {
    await insert(1, NOW - 181 * D);
    await insert(1, NOW - 1000);
    await thinPositions(env.DB, NOW, CONFIG.retentionTiers);
    expect((await allTs()).map((r: any) => r.ts)).toEqual([NOW - 1000]);
  });
});
