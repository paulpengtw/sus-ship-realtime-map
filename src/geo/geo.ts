// src/geo/geo.ts — pure geometry, meters, [lon, lat] order.
export type LngLat = [number, number];

const R = 6_371_000;
const D2R = Math.PI / 180;

export function haversineM(a: LngLat, b: LngLat): number {
  const dLat = (b[1] - a[1]) * D2R;
  const dLon = (b[0] - a[0]) * D2R;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * D2R) * Math.cos(b[1] * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function pointToSegmentM(p: LngLat, a: LngLat, b: LngLat): number {
  const k = Math.cos(p[1] * D2R);
  const ax = (a[0] - p[0]) * k * 111_320, ay = (a[1] - p[1]) * 110_540;
  const bx = (b[0] - p[0]) * k * 111_320, by = (b[1] - p[1]) * 110_540;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (-ax * dx - ay * dy) / len2));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

export function pointToPolylineM(p: LngLat, line: LngLat[]): number {
  let min = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    min = Math.min(min, pointToSegmentM(p, line[i], line[i + 1]));
  }
  return min;
}

export function pointInPolygon(p: LngLat, ring: LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}
