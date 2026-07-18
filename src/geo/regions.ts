// src/geo/regions.ts — point-in-bbox region tagging, first match wins (spec §1).
import { CONFIG, type RegionId } from "../config";

export function regionForPoint(lon: number, lat: number): RegionId | null {
  for (const r of CONFIG.regions) {
    const b = r.bbox;
    if (lon >= b.minLon && lon <= b.maxLon && lat >= b.minLat && lat <= b.maxLat) return r.id;
  }
  return null;
}

const M_PER_DEG_LAT = 111_320;

// True when (lon, lat) is outside every region bbox, or within bufferM of the OUTER
// boundary of their union (spec §3b): probe bufferM in each cardinal direction; if any
// probe leaves all bboxes, the point is near an edge beyond which we have no AIS coverage.
// Edges shared between adjacent regions (kr/jp at lon 130) are interior: the probe lands
// in the neighboring bbox and does not trigger.
export function nearCoverageEdge(lon: number, lat: number, bufferM: number): boolean {
  if (regionForPoint(lon, lat) === null) return true;
  const dLat = bufferM / M_PER_DEG_LAT;
  const dLon = bufferM / (M_PER_DEG_LAT * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  const probes: [number, number][] = [[lon - dLon, lat], [lon + dLon, lat], [lon, lat - dLat], [lon, lat + dLat]];
  return probes.some(([plon, plat]) => regionForPoint(plon, plat) === null);
}
