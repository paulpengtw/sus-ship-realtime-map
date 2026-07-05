// web/src/cablepanel.ts — corridor metadata + 30-day anomaly count within the corridor buffer (spec §3).
import { fetchEvents } from "./api";
import { cableByName, type CableInfo } from "./cables";
import { pointToPolylineM } from "./geo";
import { map } from "./main";

const BUFFER_M = 1000;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

function render(cable: CableInfo, bufferCount: number | null): void {
  const body = document.getElementById("cable-panel-body")!;
  body.innerHTML = `
    <h2>${esc(cable.name)}</h2>
    <div class="notes">Route approximate · region ${esc(cable.region.toUpperCase())}</div>
    <h3>Cable systems</h3>
    <ul>${cable.systems.map((s) => `<li>${esc(s)}</li>`).join("") || "<li>—</li>"}</ul>
    <h3>Landing points</h3>
    <ul>${cable.landing_points.map((s) => `<li>${esc(s)}</li>`).join("") || "<li>—</li>"}</ul>
    ${cable.notes ? `<h3>Notes</h3><div class="notes">${esc(cable.notes)}</div>` : ""}
    <div class="buffer-count">${bufferCount === null ? "Counting nearby anomalies…"
      : `<b>${bufferCount}</b> anomaly event${bufferCount === 1 ? "" : "s"} within ${BUFFER_M / 1000} km · last 30 days`}</div>`;
  document.getElementById("cable-panel")!.hidden = false;
}

async function open(name: string): Promise<void> {
  const cable = cableByName(name);
  if (!cable) return;
  render(cable, null);
  try {
    const res = await fetchEvents(Date.now() - 30 * 86_400_000, undefined, 1000);
    const n = res.events.filter((e) => pointToPolylineM([e.lon, e.lat], cable.coordinates) <= BUFFER_M).length;
    render(cable, n);
  } catch (err) { console.error("cable panel count failed:", err); }
}

export function initCablePanel(): void {
  document.getElementById("cable-panel-close")!.addEventListener("click", () => {
    document.getElementById("cable-panel")!.hidden = true;
  });
  map.on("click", "cable-glow", (e) => {
    if (map.queryRenderedFeatures(e.point, { layers: ["vessels"] }).length) return;
    const name = e.features?.[0]?.properties?.name;
    if (name) void open(String(name));
  });
  map.on("mouseenter", "cable-glow", () => { map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", "cable-glow", () => { map.getCanvas().style.cursor = ""; });
}
