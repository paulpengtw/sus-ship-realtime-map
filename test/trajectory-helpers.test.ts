// test/trajectory-helpers.test.ts
import { describe, expect, it } from "vitest";
import { decimatePoints, parseWindow, WINDOWS } from "../src/trajectories";

describe("parseWindow", () => {
  it("maps the five window ids to milliseconds", () => {
    expect(parseWindow("day")).toBe(86_400_000);
    expect(parseWindow("week")).toBe(7 * 86_400_000);
    expect(parseWindow("month")).toBe(30 * 86_400_000);
    expect(parseWindow("3m")).toBe(90 * 86_400_000);
    expect(parseWindow("6m")).toBe(180 * 86_400_000);
  });
  it("defaults an absent param to month", () => {
    expect(parseWindow(null)).toBe(WINDOWS.month);
  });
  it("rejects junk (caller turns null into a 400)", () => {
    expect(parseWindow("year")).toBeNull();
    expect(parseWindow("")).toBeNull();
    expect(parseWindow("MONTH")).toBeNull();
  });
});

describe("decimatePoints", () => {
  const pts = Array.from({ length: 1200 }, (_, i) => [i, i, i] as [number, number, number]);
  it("returns short arrays untouched", () => {
    expect(decimatePoints(pts.slice(0, 500), 500)).toHaveLength(500);
    expect(decimatePoints([], 500)).toEqual([]);
  });
  it("caps long arrays at max, keeping first and last", () => {
    const out = decimatePoints(pts, 500);
    expect(out).toHaveLength(500);
    expect(out[0]).toEqual(pts[0]);
    expect(out[499]).toEqual(pts[1199]);
  });
});
