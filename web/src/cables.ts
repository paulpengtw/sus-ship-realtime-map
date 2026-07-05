// web/src/cables.ts — client-side corridor metadata + nearest-corridor lookup (spec §3).
import { pointToPolylineM, type LngLat } from "./geo";

export interface CableInfo {
  name: string; region: string; systems: string[]; landing_points: string[]; notes: string;
  coordinates: LngLat[];
}

let cables: CableInfo[] = [];

export async function loadCables(): Promise<void> {
  if (cables.length) return;
  const res = await fetch("/data/cables.json");
  if (!res.ok) throw new Error(`cables.json → ${res.status}`);
  const fc = await res.json();
  cables = fc.features.map((f: any) => ({
    name: f.properties.name,
    region: f.properties.region,
    systems: f.properties.systems ?? [],
    landing_points: f.properties.landing_points ?? [],
    notes: f.properties.notes ?? "",
    coordinates: f.geometry.coordinates,
  }));
}

export function nearestCorridor(p: LngLat): { cable: CableInfo; distanceM: number } | null {
  let best: { cable: CableInfo; distanceM: number } | null = null;
  for (const c of cables) {
    const d = pointToPolylineM(p, c.coordinates);
    if (!best || d < best.distanceM) best = { cable: c, distanceM: d };
  }
  return best;
}

export function cableByName(name: string): CableInfo | null {
  return cables.find((c) => c.name === name) ?? null;
}
