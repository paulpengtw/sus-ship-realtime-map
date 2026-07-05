// web/src/api.ts — mirrors Task 11 response shapes.
export interface VesselProps { mmsi: number; name: string | null; sog: number; cog: number; score: number; lastTs: number; region: string | null; shipType: number | null; activeEvents: number; topType: string | null }
export interface Snapshot { generatedAt: number; newestTs: number | null; vessels: GeoJSON.FeatureCollection<GeoJSON.Point, VesselProps> }
export interface ApiEvent { id: string; type: string; severity: number; mmsi: number; lon: number; lat: number; startTs: number; endTs: number | null; evidence: Record<string, unknown>; region: string | null }
export interface EventsResponse { generatedAt: number; events: ApiEvent[] }
export interface GfwEvent { id: string; type: string; mmsi: number | null; lon: number; lat: number; startTs: number; endTs: number | null }
export interface GfwResponse { generatedAt: number; events: GfwEvent[] }
export interface Dossier {
  generatedAt: number;
  vessel: { mmsi: number; name: string | null; callsign: string | null; lon: number; lat: number; sog: number; cog: number; lastTs: number; score: number; region: string | null; shipType: number | null; destination: string | null; dimBow: number | null; dimStern: number | null; dimPort: number | null; dimStarboard: number | null };
  events: ApiEvent[];
}
export interface RegionStats { vessels: number; activeAlerts: number; events24h: number }
export interface DayBucket { day: string; counts: number[] }
export interface StatsResponse { generatedAt: number; regions: Record<string, RegionStats>; histogram: Record<string, DayBucket[]> }
export interface TrajectoryVessel { mmsi: number; name: string | null; score: number; topType: string | null; points: [number, number, number][] }
export interface TrajectoriesResponse { generatedAt: number; trajectories: TrajectoryVessel[] }
export interface TrackPoint { ts: number; lon: number; lat: number; sog: number; cog: number }
export interface GfwBreadcrumb { id: string; type: string; lon: number; lat: number; startTs: number; endTs: number | null }
export interface TrackResponse { generatedAt: number; points: TrackPoint[]; gfwEvents: GfwBreadcrumb[]; gfwError: boolean }

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export const fetchSnapshot = () => get<Snapshot>("/api/snapshot");
export const fetchEvents = (since: number, region?: string, limit?: number) =>
  get<EventsResponse>(`/api/events?since=${since}${region ? `&region=${region}` : ""}${limit ? `&limit=${limit}` : ""}`);
export const fetchGfw = () => get<GfwResponse>("/api/gfw");
export const fetchVessel = (mmsi: number) => get<Dossier>(`/api/vessel/${mmsi}`);
export const fetchStats = () => get<StatsResponse>("/api/stats");
export const fetchTrajectories = (region: string, window: string) =>
  get<TrajectoriesResponse>(`/api/trajectories?region=${region}&window=${window}`);
export const fetchVesselTrack = (mmsi: number, window: string) =>
  get<TrackResponse>(`/api/vessel/${mmsi}/track?window=${window}`);
