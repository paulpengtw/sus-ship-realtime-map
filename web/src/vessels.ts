// web/src/vessels.ts
import type { GeoJSONSource } from "maplibre-gl";
import { fetchGfw, fetchSnapshot } from "./api";
import { map } from "./main";

const POLL_MS = 15_000;
const STALE_MS = 5 * 60_000; // keep in sync with CONFIG.staleAfterMs
const PULSE_MS = 1500;       // sus-halo pulse period (spec: ~1.5 s)

// A vessel is "sus" when the backend reports an open detector event.
// coalesce keeps old cached snapshots (no activeEvents property) rendering as calm.
const SUS_ACTIVE = [">", ["coalesce", ["get", "activeEvents"], 0], 0] as any;
// grey → amber → red by suspicion score; solid red overrides the ramp while an event is open.
const COLOR = ["case", SUS_ACTIVE, "#ff2b2b",
  ["interpolate", ["linear"], ["get", "score"], 0, "#aab6c8", 3, "#f0a83c", 8, "#e5484d"]] as any;
// Heading is only trustworthy when the vessel is actually moving (spec: sog >= 0.5 kn).
const HAS_HEADING = ["all", ["has", "cog"], [">=", ["coalesce", ["get", "sog"], 0], 0.5]] as any;

function setStaleBanner(newestTs: number | null): void {
  const el = document.getElementById("stale-banner")!;
  if (newestTs !== null && Date.now() - newestTs > STALE_MS) {
    const t = new Date(newestTs);
    el.textContent = ;
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

// Generated SDF so MapLibre can tint the icon via icon-color (only SDF icons are tintable).
// TinySDF-style encoding: alpha ≈ 191 (0.75) at the shape edge, higher inside, lower outside.
function triangleSdfImage(size = 64): { width: number; height: number; data: Uint8Array } {
  const v: [number, number][] = [
    [0.5 * size, 0.06 * size],  // tip — points up = direction of travel at icon-rotate 0
    [0.88 * size, 0.94 * size], // starboard base corner
    [0.12 * size, 0.94 * size], // port base corner
  ];
  const segDist = (px: number, py: number, [ax, ay]: [number, number], [bx, by]: [number, number]): number => {
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };
  const data = new Uint8Array(size * size * 4);
  const radius = size / 8; // distance-field falloff
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5;
      let inside = true;
      let d = Infinity;
      for (let i = 0; i < 3; i++) {
        const a = v[i], b = v[(i + 1) % 3];
        d = Math.min(d, segDist(px, py, a, b));
        // with this winding, interior points have a positive cross product on every edge
        if ((b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0]) < 0) inside = false;
      }
      const signedOutside = inside ? -d : d;
      const alpha = Math.max(0, Math.min(255, Math.round(255 - 255 * (signedOutside / radius + 0.25))));
      data[(y * size + x) * 4 + 3] = alpha;
    }
  }
  return { width: size, height: size, data };
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

function startPulse(): void {
  const frame = (t: number): void => {
    const s = (Math.sin(((t % PULSE_MS) / PULSE_MS) * 2 * Math.PI) + 1) / 2; // 0→1 sinusoid
    if (map.getLayer("sus-halo")) {
      map.setPaintProperty("sus-halo", "circle-radius", 10 + 8 * s);
      map.setPaintProperty("sus-halo", "circle-stroke-opacity", 0.9 - 0.6 * s);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

export function initVessels(onSelect: (mmsi: number) => void): void {
  map.addImage("vessel-triangle", triangleSdfImage(), { sdf: true });

  map.addSource("vessels", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addSource("gfw", { type: "geojson", data: { type: "FeatureCollection", features: [] } });

  // GFW-confirmed (delayed) — distinct hollow diamond style under the live layers.
  map.addLayer({ id: "gfw-events", type: "circle", source: "gfw",
    paint: { "circle-radius": 7, "circle-color": "transparent", "circle-stroke-color": "#b18cff", "circle-stroke-width": 1.5 } });

  // Dot fallback: stationary vessels or no usable heading.
  map.addLayer({
    id: "vessels-dot", type: "circle", source: "vessels",
    filter: ["!", HAS_HEADING],
    paint: {
      "circle-color": COLOR,
      "circle-radius": ["case", SUS_ACTIVE, 5.5, 3.5],
      "circle-stroke-color": "#0b1220", "circle-stroke-width": 1,
      "circle-opacity": 0.95,
    },
  });

  // Heading-rotated triangles, MarineTraffic-style. Sus icons render ~1.5× larger.
  map.addLayer({
    id: "vessels", type: "symbol", source: "vessels",
    filter: HAS_HEADING,
    layout: {
      "icon-image": "vessel-triangle",
      "icon-size": ["case", SUS_ACTIVE, 0.3, 0.2], // 64 px SDF → ~13 px calm, ~19 px sus
      "icon-rotate": ["get", "cog"],
      "icon-rotation-alignment": "map",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
    },
    paint: { "icon-color": COLOR, "icon-halo-color": "#0b1220", "icon-halo-width": 0.5 },
  });

  // Pulsing red halo for vessels with open events — drawn above all traffic.
  map.addLayer({
    id: "sus-halo", type: "circle", source: "vessels",
    filter: SUS_ACTIVE,
    paint: {
      "circle-radius": 10, "circle-color": "transparent",
      "circle-stroke-color": "#ff2b2b", "circle-stroke-width": 2, "circle-stroke-opacity": 0.9,
    },
  });

  for (const layer of ["vessels", "vessels-dot"]) {
    map.on("click", layer, (e) => {
      const f = e.features?.[0];
      if (f) onSelect((f.properties as any).mmsi);
    });
    map.on("mouseenter", layer, () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; });
  }

  startPulse();
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
