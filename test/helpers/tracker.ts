// test/helpers/tracker.ts — seed TrackerDO in-memory state for API tests.
// seedTracker resets the singleton instance and marks it hydrated so DO routes never read D1
// for vessels. Correct whether or not the pool reuses the DO instance between tests.
import { env, runInDurableObject } from "cloudflare:test";
import type { TrackerDO } from "../../src/do/tracker";
import { newVesselState, type VesselState } from "../../src/types";

export function trackerStub(): DurableObjectStub<TrackerDO> {
  return env.TRACKER.get(env.TRACKER.idFromName("singleton")) as DurableObjectStub<TrackerDO>;
}

export async function seedTracker(states: VesselState[]): Promise<void> {
  await runInDurableObject(trackerStub(), (inst: TrackerDO) => {
    inst.resetForTests();
    for (const s of states) inst.tracker.states.set(s.mmsi, s);
  });
}

export function vesselAt(mmsi: number, lon: number, lat: number, ts: number, extra: Partial<VesselState> = {}): VesselState {
  const s = newVesselState(mmsi, ts);
  s.ring.push({ mmsi, lon, lat, sog: 0.5, cog: 90, heading: null, ts });
  s.lastSeen = ts;
  return Object.assign(s, extra);
}
