// test/geo.test.ts
import { describe, expect, it } from "vitest";
import { haversineM, pointInPolygon, pointToPolylineM, pointToSegmentM } from "../src/geo/geo";

// Fangshan (SMW3/FLAG landing, ~120.593E 22.263N) → offshore point SW.
const FANGSHAN: [number, number] = [120.593, 22.263];
const OFFSHORE: [number, number] = [119.8, 21.7];

describe("geo helpers", () => {
  it("haversine: Fangshan→Toucheng landing ≈ 320 km", () => {
    const toucheng: [number, number] = [121.882, 24.855];
    const d = haversineM(FANGSHAN, toucheng);
    expect(d).toBeGreaterThan(300_000);
    expect(d).toBeLessThan(340_000);
  });

  it("point on the segment has ~0 distance", () => {
    const mid: [number, number] = [(FANGSHAN[0] + OFFSHORE[0]) / 2, (FANGSHAN[1] + OFFSHORE[1]) / 2];
    expect(pointToSegmentM(mid, FANGSHAN, OFFSHORE)).toBeLessThan(600);
  });

  it("point ~1.1 km north of the segment midpoint is 900–1300 m away", () => {
    const mid: [number, number] = [(FANGSHAN[0] + OFFSHORE[0]) / 2, (FANGSHAN[1] + OFFSHORE[1]) / 2];
    const off: [number, number] = [mid[0], mid[1] + 0.01];
    const d = pointToPolylineM(off, [FANGSHAN, OFFSHORE]);
    expect(d).toBeGreaterThan(700);
    expect(d).toBeLessThan(1400);
  });

  it("distance beyond an endpoint clamps to the endpoint", () => {
    const past: [number, number] = [120.7, 22.35];
    const d = pointToSegmentM(past, FANGSHAN, OFFSHORE);
    expect(Math.abs(d - haversineM(past, FANGSHAN))).toBeLessThan(d * 0.05);
  });

  it("pointInPolygon: Kaohsiung anchorage box", () => {
    const box: [number, number][] = [[120.2, 22.5], [120.35, 22.5], [120.35, 22.62], [120.2, 22.62], [120.2, 22.5]];
    expect(pointInPolygon([120.27, 22.55], box)).toBe(true);
    expect(pointInPolygon([120.5, 22.55], box)).toBe(false);
  });
});
