// web/src/panels.ts
import type { GeoJSONSource } from "maplibre-gl";
import { fetchEvents, fetchVessel, type ApiEvent } from "./api";
import { writeHash } from "./hash";
import { hashState, map } from "./main";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const fmtTime = (ts: number) => new Date(ts).toISOString().replace("T", " ").slice(0, 16) + "Z";
const TYPE_LABEL: Record<string, string> = { loitering: "Loitering", ais_gap: "AIS gap", identity: "Identity anomaly", anchor_drag: "Anchor drag" };

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

  const list = document.getElementById("event-list")!;
  const poll = async () => {
    try {
      const res = await fetchEvents(Date.now() - 24 * 3_600_000);
      list.innerHTML = res.events.map(renderEvent).join("") || "<li>No events in the last 24 h</li>";
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
