// scripts/materialize/event-cluster.ts (spec §3b, source=event_cluster).
import { candidatesFromEventClusters } from "../../src/materialize-server";
import type { CandidateIncident } from "../../src/labeling";

const BUCKET_MS = 30 * 60_000;
const MIN_EVENTS = 3;

export async function materializeEventClusters(deps: { origin: string; now: number; lookbackMs: number }): Promise<CandidateIncident[]> {
  const since = deps.now - deps.lookbackMs;
  const res = await fetch(`${deps.origin}/api/labels/materialize/event-clusters?since=${since}&until=${deps.now}`);
  if (!res.ok) throw new Error(`fetch event-clusters failed: ${res.status}`);
  const { events, assessmentWindows } = await res.json() as { events: any[]; assessmentWindows: any[] };
  return candidatesFromEventClusters(events, assessmentWindows, BUCKET_MS, MIN_EVENTS, deps.now);
}
