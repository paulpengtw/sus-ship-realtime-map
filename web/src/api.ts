// web/src/api.ts — mirrors Task 11 response shapes.
export interface VesselProps { mmsi: number; name: string | null; sog: number; cog: number; score: number; lastTs: number; region: string | null; shipType: number | null; assessments: { category: string; confidence: number }[]; topCategory: string | null; maxConfidence: number }
export interface Snapshot { generatedAt: number; newestTs: number | null; vessels: GeoJSON.FeatureCollection<GeoJSON.Point, VesselProps> }
export interface ApiEvent { id: string; type: string; severity: number; mmsi: number; lon: number; lat: number; startTs: number; endTs: number | null; evidence: Record<string, unknown>; region: string | null }
export interface EventsResponse { generatedAt: number; events: ApiEvent[] }
export interface GfwEvent { id: string; type: string; mmsi: number | null; lon: number; lat: number; startTs: number; endTs: number | null }
export interface GfwResponse { generatedAt: number; events: GfwEvent[] }
export interface AssessmentEvidence { eventId: string; type: string; kind: string | null; weight: number; ts: number; summary: string }
export interface Assessment {
  id: string; mmsi: number; category: string; status: "open" | "closed";
  confidence: number; openedTs: number; updatedTs: number; closedTs: number | null;
  evidence: AssessmentEvidence[]; narrative: string; region: string | null; lastLon: number; lastLat: number;
}
export interface AssessmentsResponse { generatedAt: number; assessments: Assessment[] }
export interface Dossier {
  generatedAt: number;
  vessel: { mmsi: number; name: string | null; callsign: string | null; lon: number; lat: number; sog: number; cog: number; lastTs: number; score: number; region: string | null; shipType: number | null; destination: string | null; dimBow: number | null; dimStern: number | null; dimPort: number | null; dimStarboard: number | null };
  events: ApiEvent[];
  assessments: Assessment[];
}
export interface RegionStats { vessels: number; activeAlerts: number; events24h: number }
export interface DayBucket { day: string; counts: number[] }
export interface StatsResponse { generatedAt: number; regions: Record<string, RegionStats>; histogram: Record<string, DayBucket[]> }
export interface TrajectoryVessel { mmsi: number; name: string | null; confidence: number; topCategory: string | null; points: [number, number, number][] }
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
export const fetchAssessments = (region?: string, window?: string) =>
  get<AssessmentsResponse>(`/api/assessments?${region ? `region=${region}&` : ""}window=${window ?? "day"}`);
export const fetchVessel = (mmsi: number) => get<Dossier>(`/api/vessel/${mmsi}`);
export const fetchStats = () => get<StatsResponse>("/api/stats");
export const fetchTrajectories = (region: string, window: string) =>
  get<TrajectoriesResponse>(`/api/trajectories?region=${region}&window=${window}`);
export const fetchVesselTrack = (mmsi: number, window: string) =>
  get<TrackResponse>(`/api/vessel/${mmsi}/track?window=${window}`);

export interface ApiCandidate {
  id: string; vesselId: string; tStart: number; tEnd: number;
  source: "assessment" | "event_cluster" | "random_negative" | "curated_positive";
  sourceRef: string | null; createdAt: number;
  modelSnapshot: unknown; eventIds: string[];
}
export async function fetchLabelQueue(source?: string, limit = 25): Promise<{ candidates: ApiCandidate[] }> {
  const qs = new URLSearchParams();
  if (source) qs.set("source", source);
  qs.set("limit", String(limit));
  const res = await fetch(`/api/labels/queue?${qs}`);
  if (!res.ok) throw new Error(`labels/queue ${res.status}`);
  return res.json();
}
export async function fetchLabelStats(): Promise<{
  bySource: Record<string, { total: number; labeled: number }>;
  byVerdict: { threat: number; suspicious: number; benign: number; unclear: number };
  imbalance: { threatVsBenign: number };
}> {
  const res = await fetch("/api/labels/stats");
  if (!res.ok) throw new Error(`labels/stats ${res.status}`);
  return res.json();
}

export async function fetchVesselTrackRange(mmsi: number, from: number, to: number): Promise<{
  points: { ts: number; lon: number; lat: number; sog: number; cog: number }[];
  gfwEvents: { id: string; type: string; lon: number; lat: number; startTs: number; endTs: number | null }[];
  gfwError?: unknown;
}> {
  const res = await fetch(`/api/vessel/${mmsi}/track?from=${from}&to=${to}`);
  if (!res.ok) throw new Error(`vessel/track ${res.status}`);
  return res.json();
}

export interface PostLabelBody {
  incidentId: string; labeler: string; verdict: "threat" | "suspicious" | "benign" | "unclear";
  intentCategories?: string[]; labelerConfidence?: number; notes?: string;
}
export async function postLabel(body: PostLabelBody): Promise<{ ok: true; id: number } | { error: string }> {
  const res = await fetch("/api/labels", { method: "POST", body: JSON.stringify(body) });
  return res.json();
}
