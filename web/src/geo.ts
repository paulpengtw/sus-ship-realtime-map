// web/src/geo.ts — client copy of src/geo/geo.ts distance math (web must not import outside the Vite root).
export type LngLat = [number, number];

const D2R = Math.PI / 180;

function pointToSegmentM(p: LngLat, a: LngLat, b: LngLat): number {
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
  for (let i = 0; i < line.length - 1; i++) min = Math.min(min, pointToSegmentM(p, line[i], line[i + 1]));
  return min;
}
