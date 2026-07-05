// src/trajectories.ts — pure window/decimation helpers for the trajectory endpoints.

export const WINDOWS = {
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
  "3m": 90 * 86_400_000,
  "6m": 180 * 86_400_000,
} as const;
export type WindowId = keyof typeof WINDOWS;

// Absent param defaults to month (the UI default); unknown ids return null so the caller can 400.
export function parseWindow(w: string | null): number | null {
  if (w === null) return WINDOWS.month;
  return Object.prototype.hasOwnProperty.call(WINDOWS, w) ? WINDOWS[w as WindowId] : null;
}

// Uniform stride sampling that always keeps the first and last point.
export function decimatePoints<T>(points: T[], max: number): T[] {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
  return out;
}
