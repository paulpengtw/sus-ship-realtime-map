import cablesData from "../../data/cables.json";
import exclusionsData from "../../data/exclusions.json";
import lanesData from "../../data/lanes.json";
import { CONFIG } from "../config";
import { pointInPolygon, pointToPolylineM, type LngLat } from "./geo";

interface LineFeature { properties: { name: string }; geometry: { type: "LineString"; coordinates: LngLat[] } }
interface PolyFeature { properties: { name: string }; geometry: { type: "Polygon"; coordinates: LngLat[][] } }
interface FC<F> { features: F[] }

export interface CorridorHit { name: string; distanceM: number }
export interface LaneHit { name: string; distanceM: number }

export class GeoContext {
  constructor(
    private cables: FC<LineFeature> = cablesData as unknown as FC<LineFeature>,
    private exclusions: FC<PolyFeature> = exclusionsData as unknown as FC<PolyFeature>,
    private bufferM: number = CONFIG.corridorBufferM,
    private lanes: FC<LineFeature> = lanesData as unknown as FC<LineFeature>,
    private laneBufferM: number = CONFIG.laneBufferM,
  ) {}

  nearestCorridor(p: LngLat): CorridorHit | null {
    let best: CorridorHit | null = null;
    for (const f of this.cables.features) {
      const d = pointToPolylineM(p, f.geometry.coordinates);
      if (!best || d < best.distanceM) best = { name: f.properties.name, distanceM: d };
    }
    return best;
  }

  inCorridor(p: LngLat): boolean {
    const hit = this.nearestCorridor(p);
    return hit !== null && hit.distanceM <= this.bufferM;
  }

  inExclusion(p: LngLat): boolean {
    return this.exclusions.features.some((f) => pointInPolygon(p, f.geometry.coordinates[0]));
  }

  nearestLane(p: LngLat): LaneHit | null {
    let best: LaneHit | null = null;
    for (const f of this.lanes.features) {
      const d = pointToPolylineM(p, f.geometry.coordinates);
      if (!best || d < best.distanceM) best = { name: f.properties.name, distanceM: d };
    }
    return best;
  }

  inLane(p: LngLat): boolean {
    const hit = this.nearestLane(p);
    return hit !== null && hit.distanceM <= this.laneBufferM;
  }
}
