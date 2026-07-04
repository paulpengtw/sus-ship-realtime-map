// web/src/vessels.ts
import type { GeoJSONSource } from "maplibre-gl";
import { fetchGfw, fetchSnapshot } from "./api";
import { map } from "./main";

const POLL_MS = 15_000;
const STALE_MS = 5 * 60_000; // keep in sync with CONFIG.staleAfterMs

function setStaleBanner(newestTs: number | null): void {
  const el = document.getElementById("stale-banner")!;
  if (newestTs !== null && Date.now() - newestTs > STALE_MS) {
    const t = new Date(newestTs);
    el.textContent = `⚠ data stale since ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

async function poll(): Promise<void> {
  try {
    const snap = await fetchSnapshot();
    (map.getSource("vessels") as GeoJSONSource | undefined)?.setData(snap.vessels as any);
    setStaleBanner(snap.newestTs);
  } catch (err) {
    console.error("snapshot poll failed:", err);
    setStaleBanner(0); // unreachable API = stale (spec §6: never silently show stale data)
  }
}

export function initVessels(onSelect: (mmsi: number) => void): void {
  map.addSource("vessels", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addSource("gfw", { type: "geojson", data: { type: "FeatureCollection", features: [] } });

  // GFW-confirmed (delayed) — distinct hollow diamond style under the live layer.
  map.addLayer({ id: "gfw-events", type: "circle", source: "gfw",
    paint: { "circle-radius": 7, "circle-color": "transparent", "circle-stroke-color": "#b18cff", "circle-stroke-width": 1.5 } });

  map.addLayer({
    id: "vessels", type: "circle", source: "vessels",
    paint: {
      // grey → amber → red by suspicion score (spec §5)
      "circle-color": ["interpolate", ["linear"], ["get", "score"], 0, "#8b96a5", 3, "#f0a83c", 8, "#e5484d"],
      "circle-radius": ["interpolate", ["linear"], ["get", "score"], 0, 3.5, 8, 7],
      "circle-stroke-color": "#0b1220", "circle-stroke-width": 1,
      "circle-opacity": 0.9,
    },
  });

  map.on("click", "vessels", (e) => {
    const f = e.features?.[0];
    if (f) onSelect((f.properties as any).mmsi);
  });
  map.on("mouseenter", "vessels", () => { map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", "vessels", () => { map.getCanvas().style.cursor = ""; });

  void poll();
  setInterval(poll, POLL_MS);

  void fetchGfw().then((g) => {
    (map.getSource("gfw") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: g.events.map((ev) => ({
        type: "Feature", geometry: { type: "Point", coordinates: [ev.lon, ev.lat] },
        properties: { id: ev.id, type: ev.type, gfw: true },
      })),
    } as any);
  }).catch((err) => console.error("gfw layer failed:", err));
}
