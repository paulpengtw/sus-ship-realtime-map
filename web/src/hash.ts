// web/src/hash.ts — shareable permalinks: #v=<lon>,<lat>,<zoom>&vessel=<mmsi>
export interface HashState { view?: { lon: number; lat: number; zoom: number }; vessel?: number }

export function readHash(): HashState {
  const params = new URLSearchParams(location.hash.slice(1));
  const out: HashState = {};
  const v = params.get("v")?.split(",").map(Number);
  if (v && v.length === 3 && v.every(Number.isFinite)) out.view = { lon: v[0], lat: v[1], zoom: v[2] };
  const m = Number(params.get("vessel"));
  if (Number.isInteger(m) && m > 0) out.vessel = m;
  return out;
}

export function writeHash(state: HashState): void {
  const params = new URLSearchParams();
  if (state.view) params.set("v", `${state.view.lon.toFixed(4)},${state.view.lat.toFixed(4)},${state.view.zoom.toFixed(2)}`);
  if (state.vessel) params.set("vessel", String(state.vessel));
  history.replaceState(null, "", `#${params}`);
}
