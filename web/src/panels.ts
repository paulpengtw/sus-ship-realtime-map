// web/src/panels.ts
import type { GeoJSONSource } from "maplibre-gl";
import { fetchEvents, fetchVessel, type ApiEvent } from "./api";
import { writeHash } from "./hash";
import { hashState, map } from "./main";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const fmtTime = (ts: number) => new Date(ts).toISOString().replace("T", " ").slice(0, 16) + "Z";
const TYPE_LABEL: Record<string, string> = {
  loitering: "Loitering", ais_gap: "AIS gap", identity: "Identity anomaly",
  anchor_drag: "Anchor drag", speed_anomaly: "Speed anomaly", route_deviation: "Route deviation",
};

export function selectVessel(mmsi: number | null): void {
  const panel = document.getElementById("dossier")!;
  hashState.vessel = mmsi ?? undefined;
  writeHash(hashState);

  if (mmsi === null) {
    panel.hidden = true;
    (map.getSource("track") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: [] } as any);
    return;
  }

  void fetchVessel(mmsi).then((d) => {
    const body = document.getElementById("dossier-body")!;
    const identityEvents = d.events.filter((e) => e.type === "identity");
    body.innerHTML = `
      <h2>${esc(d.vessel.name) || "Unknown vessel"}</h2>
      <div class="score">${d.vessel.score}</div>
      <div>MMSI ${d.vessel.mmsi} · ${esc(d.vessel.callsign) || "no callsign"} · ${d.vessel.sog} kn</div>
      <div>Last seen ${fmtTime(d.vessel.lastTs)}</div>
      <h3>Identity history</h3>
      <ul>${identityEvents.length ? identityEvents.map((e) => `<li>${fmtTime(e.startTs)} — ${esc(JSON.stringify(e.evidence))}</li>`).join("") : "<li>No identity changes observed</li>"}</ul>
      <h3>Event timeline</h3>
      <ul>${d.events.length ? d.events.map((e) => `<li>${fmtTime(e.startTs)} — ${TYPE_LABEL[e.type] ?? e.type} (sev ${e.severity})${e.endTs === null ? " · ongoing" : ""}</li>`).join("") : "<li>No events</li>"}</ul>`;
    panel.hidden = false;

    (map.getSource("track") as GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection", features: []
    } as any);
    const track = map.getSource("track") as GeoJSONSource | undefined;
    if (track && d.track.length > 1) {
      track.setData({ type: "Feature", properties: {},
        geometry: { type: "LineString", coordinates: d.track.map((p) => [p.lon, p.lat]) } } as any);
    }
  }).catch((err) => console.error("dossier failed:", err));
}

function renderEvent(ev: ApiEvent): string {
  const sevClass = ev.severity >= 4 ? "sev-high" : ev.severity === 3 ? "sev-mid" : "sev-low";
  return `<li data-lon="${ev.lon}" data-lat="${ev.lat}" data-mmsi="${ev.mmsi}">
    <span class="sev ${sevClass}">sev ${ev.severity}</span> ${TYPE_LABEL[ev.type] ?? ev.type} — MMSI ${ev.mmsi}${ev.endTs === null ? " · ongoing" : ""}
    <time>${fmtTime(ev.startTs)}</time></li>`;
}

export function initEventFeed(): void {
  map.addSource("track", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "track", type: "line", source: "track",
    paint: { "line-color": "#4cc3ff", "line-width": 2, "line-opacity": 0.7 } }, "vessels");

  const chipsEl = document.getElementById("filter-chips")!;
  const allTypes = ["All", "loitering", "ais_gap", "identity", "anchor_drag", "speed_anomaly", "route_deviation"];
  let activeFilter: string | null = hashState.filter ?? null;

  function renderChips(): void {
    chipsEl.innerHTML = allTypes.map((t) => {
      const label = t === "All" ? "All" : TYPE_LABEL[t] ?? t;
      const isActive = (t === "All" && !activeFilter) || activeFilter === t;
      return `<button data-type="${t}" class="${isActive ? "active" : ""}">${label}</button>`;
    }).join("");
  }

  chipsEl.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("button[data-type]") as HTMLElement | null;
    if (!btn) return;
    const type = btn.dataset.type!;
    if (type === "All" || activeFilter === type) {
      activeFilter = null;
      hashState.filter = undefined;
    } else {
      activeFilter = type;
      hashState.filter = type;
    }
    writeHash(hashState);
    renderChips();
    void poll();
  });

  renderChips();

  const list = document.getElementById("event-list")!;
  const poll = async () => {
    try {
      const res = await fetchEvents(Date.now() - 24 * 3_600_000);
      const filtered = activeFilter ? res.events.filter((e) => e.type === activeFilter) : res.events;
      list.innerHTML = filtered.map(renderEvent).join("") || "<li>No events in the last 24 h</li>";
    } catch (err) { console.error("event feed failed:", err); }
  };
  list.addEventListener("click", (e) => {
    const li = (e.target as HTMLElement).closest("li[data-mmsi]") as HTMLElement | null;
    if (!li) return;
    map.flyTo({ center: [Number(li.dataset.lon), Number(li.dataset.lat)], zoom: 10 });
    selectVessel(Number(li.dataset.mmsi));
  });
  void poll();
  setInterval(poll, 15_000);
}
