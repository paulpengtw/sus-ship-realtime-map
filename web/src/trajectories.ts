// web/src/trajectories.ts — always-on suspicious-vessel trajectory lines (trajectories spec §3).
import type { GeoJSONSource } from "maplibre-gl";
import maplibregl from "maplibre-gl";
import { fetchTrajectories } from "./api";
import { map } from "./main";
import { getRegion, onRegionChange } from "./regions";
import { getWindow, onWindowChange } from "./windows";

const POLL_MS = 60_000; // sus set changes as events open/close; cheaper than the 15 s snapshot poll
const CAT_MATCH = ["match", ["coalesce", ["get", "topCategory"], ""],
  "cable_interference", "#e5484d", "dark_activity", "#b18cff",
  "identity_deception", "#f0a83c", "#e5484d"] as any;
const NO_HOVER = ["==", ["get", "mmsi"], -1] as any;

async function refresh(): Promise<void> {
  try {
    const res = await fetchTrajectories(getRegion(), getWindow());
    (map.getSource("sus-trajectories") as GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: res.trajectories.map((t) => ({
        type: "Feature",
        geometry: { type: "LineString", coordinates: t.points.map((p) => [p[0], p[1]]) },
        properties: { mmsi: t.mmsi, name: t.name ?? `MMSI ${t.mmsi}`, confidence: t.confidence, topCategory: t.topCategory },
      })),
    } as any);
  } catch (err) {
    console.error("trajectories failed:", err);
  }
}

export function initTrajectories(onSelect: (mmsi: number) => void): void {
  map.addSource("sus-trajectories", { type: "geojson", data: { type: "FeatureCollection", features: [] } });

  // Thin semi-transparent lines under the live traffic; hover layer re-draws one line bold.
  map.addLayer({ id: "sus-trajectories", type: "line", source: "sus-trajectories",
    paint: {
      "line-color": CAT_MATCH, "line-width": 1.5,
      "line-opacity": ["interpolate", ["linear"], ["get", "confidence"], 0.2, 0.35, 1, 0.8],
    } }, "vessels-dot");
  map.addLayer({ id: "sus-trajectories-hover", type: "line", source: "sus-trajectories",
    filter: NO_HOVER,
    paint: { "line-color": CAT_MATCH, "line-width": 3, "line-opacity": 0.95 } }, "vessels-dot");

  const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });
  map.on("mousemove", "sus-trajectories", (e) => {
    const f = e.features?.[0];
    if (!f) return;
    map.setFilter("sus-trajectories-hover", ["==", ["get", "mmsi"], (f.properties as any).mmsi]);
    popup.setLngLat(e.lngLat).setText(String((f.properties as any).name)).addTo(map);
    map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", "sus-trajectories", () => {
    map.setFilter("sus-trajectories-hover", NO_HOVER);
    popup.remove();
    map.getCanvas().style.cursor = "";
  });
  map.on("click", "sus-trajectories", (e) => {
    const f = e.features?.[0];
    if (f) onSelect((f.properties as any).mmsi);
  });

  void refresh();
  setInterval(refresh, POLL_MS);
  onRegionChange(() => void refresh());
  onWindowChange(() => void refresh());
}
