// web/src/panels.ts
import type { GeoJSONSource } from "maplibre-gl";
import { fetchEvents, fetchVessel, type ApiEvent } from "./api";
import { writeHash } from "./hash";
import { hashState, map } from "./main";
import { flagForMmsi } from "./mid";
import { getRegion, onRegionChange } from "./regions";
import { shipTypeLabel } from "./shiptype";
import { nearestCorridor } from "./cables";
import { getDayFilter, onDayFilter } from "./timeline";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const fmtTime = (ts: number) => new Date(ts).toISOString().replace("T", " ").slice(0, 16) + "Z";
const TYPE_LABEL: Record<string, string> = { loitering: "Loitering", ais_gap: "AIS gap", identity: "Identity anomaly", anchor_drag: "Anchor drag" };

const REGION_LABEL: Record<string, string> = { kr: "Korea", tw: "Taiwan", jp: "Japan" };

function detectorBreakdown(events: ApiEvent[]): string {
  const byType = new Map<string, { count: number; last: number }>();
  for (const e of events) {
    const b = byType.get(e.type) ?? { count: 0, last: 0 };
    b.count++; b.last = Math.max(b.last, e.startTs);
    byType.set(e.type, b);
  }
  if (!byType.size) return "<li>No detector hits</li>";
  return [...byType].map(([type, b]) =>
    `<li>${TYPE_LABEL[type] ?? type} — ${b.count}× · last ${fmtTime(b.last)}</li>`).join("");
}

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
    const flag = flagForMmsi(d.vessel.mmsi);
    const v = d.vessel;
    const size = v.dimBow != null && v.dimStern != null && v.dimPort != null && v.dimStarboard != null
      ? `${v.dimBow + v.dimStern} × ${v.dimPort + v.dimStarboard} m` : "—";
    body.innerHTML = `
      <h2>${flag ? flag.flag + " " : ""}${esc(v.name) || "Unknown vessel"}</h2>
      <div class="score">${v.score}</div>
      <div>MMSI ${v.mmsi} · ${esc(v.callsign) || "no callsign"} · ${v.sog} kn</div>
      <div>${flag ? esc(flag.country) : "Unknown flag"} · ${shipTypeLabel(v.shipType)} · ${REGION_LABEL[v.region ?? ""] ?? "—"}</div>
      <div>Destination: ${esc(v.destination) || "—"} · Size: ${size}</div>
      <div>Last seen ${fmtTime(v.lastTs)}</div>
      <h3>Detector breakdown</h3>
      <ul>${detectorBreakdown(d.events)}</ul>
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
  const hit = nearestCorridor([ev.lon, ev.lat]);
  const corridor = hit
    ? `<span class="corridor">${esc(hit.cable.name)} · ${(hit.distanceM / 1000).toFixed(1)} km</span>`
    : "";
  return `<li data-lon="${ev.lon}" data-lat="${ev.lat}" data-mmsi="${ev.mmsi}">
    <span class="sev ${sevClass}">sev ${ev.severity}</span> ${TYPE_LABEL[ev.type] ?? ev.type} — MMSI ${ev.mmsi}${ev.endTs === null ? " · ongoing" : ""}
    ${corridor}<time>${fmtTime(ev.startTs)}</time></li>`;
}

export function initEventFeed(): void {
  map.addSource("track", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "track", type: "line", source: "track",
    paint: { "line-color": "#4cc3ff", "line-width": 2, "line-opacity": 0.7 } }, "vessels");

  const list = document.getElementById("event-list")!;
  const poll = async () => {
    try {
      const f = getDayFilter();
      const since = f ? f.startTs : Date.now() - 24 * 3_600_000;
      const res = await fetchEvents(since, getRegion());
      const events = f ? res.events.filter((e) => e.startTs < f.endTs) : res.events;
      list.innerHTML = events.map(renderEvent).join("") ||
        `<li>${f ? `No events on ${f.day}` : "No events in the last 24 h"}</li>`;
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
  onRegionChange(() => void poll());
  onDayFilter(() => void poll());
}
