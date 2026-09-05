// test/write-meter.test.ts — per-UTC-day rows_written accounting (spec 2026-09-05 §3).
import { describe, expect, it } from "vitest";
import { WriteMeter, utcDay } from "../src/write-meter";

const NOON = Date.UTC(2026, 8, 5, 12); // 2026-09-05T12:00:00Z

describe("WriteMeter", () => {
  it("accumulates within a UTC day and pauses optional writes at the budget", () => {
    const m = new WriteMeter(100);
    m.record(60, NOON);
    expect(m.optionalAllowed(NOON)).toBe(true);
    m.record(40, NOON + 1000);
    expect(m.usedToday(NOON + 1000)).toBe(100);
    expect(m.optionalAllowed(NOON + 1000)).toBe(false);
    expect(m.status(NOON + 1000)).toEqual({ day: "2026-09-05", usedToday: 100, budget: 100, optionalWritesPaused: true });
  });

  it("resets when the UTC day rolls over", () => {
    const m = new WriteMeter(100);
    m.record(100, NOON);
    const next = Date.UTC(2026, 8, 6, 0, 0, 1);
    expect(utcDay(next)).toBe("2026-09-06");
    expect(m.usedToday(next)).toBe(0);
    expect(m.optionalAllowed(next)).toBe(true);
  });

  it("ignores negative counts", () => {
    const m = new WriteMeter(10);
    m.record(-5, NOON);
    expect(m.usedToday(NOON)).toBe(0);
  });

  it("reset() forgets the day and the count", () => {
    const m = new WriteMeter(10);
    m.record(5, NOON);
    m.reset();
    expect(m.usedToday(NOON)).toBe(0);
  });
});
