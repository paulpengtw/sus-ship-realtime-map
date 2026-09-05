// test/tracker-do.test.ts — TrackerDO write policy end-to-end against the test D1 (spec 2026-09-05 §3).
import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import type { TrackerDO } from "../src/do/tracker";
import type { AisPosition } from "../src/types";
import { seedTracker, trackerStub, vesselAt } from "./helpers/tracker";

const T0 = 1_800_000_000_000; // 2027-01-15T08:00Z — +6 h stays inside the same UTC day
const MIN = 60_000, H = 3_600_000;
const fix = (mmsi: number, ts: number, lon = 120, lat = 22): AisPosition => ({ mmsi, lon, lat, sog: 5, cog: 0, heading: null, ts });

const inDO = <R>(fn: (inst: TrackerDO) => R | Promise<R>) => runInDurableObject(trackerStub(), (inst: TrackerDO) => fn(inst));
const vesselRows = async () => (await env.DB.prepare("SELECT mmsi FROM vessels ORDER BY mmsi").all<any>()).results.map((r) => r.mmsi);
const positionTs = async () => (await env.DB.prepare("SELECT ts FROM positions ORDER BY mmsi, ts").all<any>()).results.map((r) => r.ts);

describe("TrackerDO write policy", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM vessels"), env.DB.prepare("DELETE FROM positions"),
      env.DB.prepare("DELETE FROM events"), env.DB.prepare("DELETE FROM assessments"),
    ]);
    await seedTracker([]);
  });

  it("first sight writes the vessel row; an unchanged re-flush writes nothing", async () => {
    await inDO(async (inst) => {
      inst.ingest({ kind: "ok", pos: fix(1, T0) });
      await inst.flushPending(T0);
      expect(await vesselRows()).toEqual([1]);
      const used = inst.status(T0).writes.usedToday;
      expect(used).toBeGreaterThan(0);
      inst.ingest({ kind: "ok", pos: fix(1, T0 + 30_000) });
      await inst.flushPending(T0 + 30_000);
      expect(inst.status(T0 + 30_000).writes.usedToday).toBe(used);
      expect(inst.pending.dirtyVessels.size).toBe(0);
    });
  });

  it("identity change re-writes at once; an unchanged row refreshes after vesselRefreshMs", async () => {
    await inDO(async (inst) => {
      inst.ingest({ kind: "ok", pos: fix(1, T0) });
      await inst.flushPending(T0);
      inst.ingest({ kind: "ok", ident: { mmsi: 1, name: "RENAMED", callsign: "BXYZ1", shipType: 70, ts: T0 + MIN } });
      await inst.flushPending(T0 + MIN);
      expect((await env.DB.prepare("SELECT name FROM vessels WHERE mmsi = 1").first<any>()).name).toBe("RENAMED");

      const t2 = T0 + CONFIG.vesselRefreshMs - MIN;
      inst.ingest({ kind: "ok", pos: fix(1, t2) });
      await inst.flushPending(t2);
      expect((await env.DB.prepare("SELECT last_ts FROM vessels WHERE mmsi = 1").first<any>()).last_ts).toBe(T0); // lastSeen only moves on positions; row not refreshed yet

      const t3 = T0 + MIN + CONFIG.vesselRefreshMs;
      inst.ingest({ kind: "ok", pos: fix(1, t3) });
      await inst.flushPending(t3);
      expect((await env.DB.prepare("SELECT last_ts FROM vessels WHERE mmsi = 1").first<any>()).last_ts).toBe(t3);
    });
  });

  it("breadcrumbs persist only for tracked vessels, with a one-time ring backfill on track start", async () => {
    await inDO(async (inst) => {
      for (let i = 0; i < 4; i++) inst.ingest({ kind: "ok", pos: fix(1, T0 + i * 15 * MIN, 120 + i * 0.05, 22) });
      await inst.flushPending(T0 + H);
      expect(await positionTs()).toEqual([]); // untracked: nothing persisted

      inst.tracker.states.get(1)!.categories.dark_activity.score = CONFIG.trackPersistMinScore; // becomes tracked
      inst.ingest({ kind: "ok", pos: fix(1, T0 + H + MIN, 120.25, 22) });
      await inst.flushPending(T0 + H + MIN);
      expect(await positionTs()).toEqual([T0, T0 + 15 * MIN, T0 + 30 * MIN, T0 + 45 * MIN, T0 + H + MIN]);

      inst.ingest({ kind: "ok", pos: fix(1, T0 + H + 2 * MIN, 120.25, 22) }); // 1 min later, no movement → gated
      await inst.flushPending(T0 + H + 2 * MIN);
      expect(await positionTs()).toHaveLength(5);
    });
  });

  it("at the daily budget, optional writes are dropped and essentials still land", async () => {
    await inDO(async (inst) => {
      inst.meter.record(CONFIG.d1DailyWriteBudget, T0);
      const s = vesselAt(1, 120, 22, T0);
      s.categories.dark_activity.score = 1; // tracked from the start
      inst.tracker.states.set(1, s);
      inst.ingest({ kind: "ok", pos: fix(1, T0 + 1000) });
      await inst.flushPending(T0 + 1000);
      expect(await vesselRows()).toEqual([1]);   // first sight = essential
      expect(await positionTs()).toEqual([]);    // breadcrumbs = optional, dropped
      expect(inst.pending.positions).toEqual([]); // dropped, not deferred
      expect(inst.status(T0 + 1000).writes.optionalWritesPaused).toBe(true);
    });
  });

  it("a failed flush keeps essentials for retry and caps queued positions", async () => {
    await inDO(async (inst) => {
      const s = vesselAt(1, 120, 22, T0);
      s.categories.dark_activity.score = 1;
      inst.tracker.states.set(1, s);
      for (let i = 1; i <= CONFIG.pendingPositionsCap + 50; i++) {
        inst.ingest({ kind: "ok", pos: fix(1, T0 + i * CONFIG.persistMinIntervalMs) });
      }
      const failing = {
        prepare: () => ({ bind: () => ({}) }),
        batch: async () => { throw new Error("D1_ERROR: rows_written quota exceeded"); },
      } as unknown as D1Database;
      const tEnd = T0 + (CONFIG.pendingPositionsCap + 50) * CONFIG.persistMinIntervalMs;
      await inst.flushPending(tEnd, failing);
      expect(inst.pending.positions).toHaveLength(CONFIG.pendingPositionsCap);
      expect(inst.pending.dirtyVessels.has(1)).toBe(true);

      await inst.flushPending(tEnd); // real D1: retry succeeds
      expect(await vesselRows()).toEqual([1]);
      expect(await positionTs()).toHaveLength(CONFIG.pendingPositionsCap);
      expect(inst.pending.positions).toEqual([]);
    });
  });

  it("/status exposes the write meter", async () => {
    const res = await trackerStub().fetch("https://do/status");
    const body = await res.json<any>();
    expect(body.writes).toMatchObject({ budget: CONFIG.d1DailyWriteBudget, optionalWritesPaused: false });
    expect(body.writes.usedToday).toBeGreaterThanOrEqual(0);
  });
});
