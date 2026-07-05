// web/src/api.ts — mirrors Task 11 response shapes.
export interface VesselProps { mmsi: number; name: string | null; sog: number; cog: number; score: number; lastTs: number; region: string | null; shipType: number | null }
export interface Snapshot { generatedAt: number; newestTs: number | null; vessels: GeoJSON.FeatureCollection<GeoJSON.Point, VesselProps> }
export interface ApiEvent { id: string; type: string; severity: number; mmsi: number; lon: number; lat: number; startTs: number; endTs: number | null; evidence: Record<string, unknown>; region: string | null }
export interface EventsResponse { generatedAt: number; events: ApiEvent[] }
export interface GfwEvent { id: string; type: string; mmsi: number | null; lon: number; lat: number; startTs: number; endTs: number | null }
export interface GfwResponse { generatedAt: number; events: GfwEvent[] }
export interface Dossier {
  generatedAt: number;
  vessel: { mmsi: number; name: string | null; callsign: string | null; lon: number; lat: number; sog: number; cog: number; lastTs: number; score: number; region: string | null; shipType: number | null; destination: string | null; dimBow: number | null; dimStern: number | null; dimPort: number | null; dimStarboard: number | null };
  track: { ts: number; lon: number; lat: number; sog: number; cog: number }[];
  events: ApiEvent[];
}

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
