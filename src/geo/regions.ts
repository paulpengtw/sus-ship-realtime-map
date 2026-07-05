// src/geo/regions.ts — point-in-bbox region tagging, first match wins (spec §1).
import { CONFIG, type RegionId } from "../config";

export function regionForPoint(lon: number, lat: number): RegionId | null {
  for (const r of CONFIG.regions) {
    const b = r.bbox;
    if (lon >= b.minLon && lon <= b.maxLon && lat >= b.minLat && lat <= b.maxLat) return r.id;
  }
  return null;
}
