// web/src/main.ts
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { readHash, writeHash, type HashState } from "./hash";
import { initVessels } from "./vessels";
import { initEventFeed, selectVessel } from "./panels";
import { getRegion, regionDef } from "./regions";
import { initRegionSwitcher, initWindowSwitcher } from "./switcher";
import { loadCables } from "./cables";
import { initStatsBar } from "./stats";
import { initTimeline } from "./timeline";
import { initCablePanel } from "./cablepanel";
import { initOnboarding } from "./onboarding";

export const hashState: HashState = readHash();

const home = regionDef(getRegion());
export const map = new maplibregl.Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/dark",
  center: hashState.view ? [hashState.view.lon, hashState.view.lat] : home.center,
  zoom: hashState.view?.zoom ?? home.zoom,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl(), "bottom-right");

map.on("moveend", () => {
  const c = map.getCenter();
  hashState.view = { lon: c.lng, lat: c.lat, zoom: map.getZoom() };
  writeHash(hashState);
});

map.on("load", () => {
  void loadCables().catch((err) => console.error("cables load failed:", err));
  map.addSource("cables", { type: "geojson", data: "/data/cables.json" });
  map.addSource("exclusions", { type: "geojson", data: "/data/exclusions.json" });

  map.addLayer({ id: "cable-glow", type: "line", source: "cables",
    paint: { "line-color": "#4cc3ff", "line-width": 14, "line-opacity": 0.15, "line-blur": 6 } });
  map.addLayer({ id: "cable-line", type: "line", source: "cables",
    paint: { "line-color": "#4cc3ff", "line-width": 1.5, "line-opacity": 0.8, "line-dasharray": [2, 2] } });
  map.addLayer({ id: "cable-label", type: "symbol", source: "cables",
    layout: { "symbol-placement": "line", "text-field": ["concat", ["get", "name"], ["case", ["get", "approximate"], " (approximate)", ""]], "text-size": 10 },
    paint: { "text-color": "#7d8aa0", "text-halo-color": "#0b1220", "text-halo-width": 1 } });

  map.addLayer({ id: "exclusion-fill", type: "fill", source: "exclusions",
    layout: { visibility: "none" }, paint: { "fill-color": "#8b96a5", "fill-opacity": 0.12 } });

  initVessels(selectVessel);
  initEventFeed();
  initRegionSwitcher();
  initWindowSwitcher();
  initStatsBar();
  initTimeline();
  initCablePanel();
  if (hashState.vessel) selectVessel(hashState.vessel);
  initOnboarding();
});

class ExclusionToggle implements maplibregl.IControl {
  onAdd(m: maplibregl.Map) {
    const div = document.createElement("div");
    div.className = "maplibregl-ctrl maplibregl-ctrl-group";
    const btn = document.createElement("button");
    btn.textContent = "⚓";
    btn.title = "Toggle exclusion zones";
    btn.onclick = () => {
      const vis = m.getLayoutProperty("exclusion-fill", "visibility") === "none" ? "visible" : "none";
      m.setLayoutProperty("exclusion-fill", "visibility", vis);
    };
    div.appendChild(btn);
    return div;
  }
  onRemove() {}
}
map.addControl(new ExclusionToggle(), "bottom-right");
document.getElementById("dossier-close")!.addEventListener("click", () => selectVessel(null));
