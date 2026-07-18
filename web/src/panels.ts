// web/src/panels.ts
import type { GeoJSONSource } from "maplibre-gl";
import { fetchAssessments, fetchVessel, fetchVesselTrack, type ApiEvent, type GfwBreadcrumb } from "./api";
import { CATEGORY_LABEL, renderAssessmentCard, renderAssessmentItem } from "./assess";
import { writeHash } from "./hash";
import { hashState, map } from "./main";
import { flagForMmsi } from "./mid";
import { getRegion, onRegionChange } from "./regions";
import { shipTypeLabel } from "./shiptype";
import { nearestCorridor } from "./cables";
import { getDayFilter, onDayFilter } from "./timeline";
import { getWindow, onWindowChange } from "./windows";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const fmtTime = (ts: number) => new Date(ts).toISOString().replace("T", " ").slice(0, 16) + "Z";
const TYPE_LABEL: Record<string, string> = {
  loitering: "Loitering", ais_gap: "AIS gap", identity: "Identity anomaly",
  anchor_drag: "Anchor drag", speed_anomaly: "Speed anomaly", route_deviation: "Route deviation",
};

const REGION_LABEL: Record<string, string> = { kr: "Korea", tw: "Taiwan", jp: "Japan" };

const CRUMB_LETTER: Record<string, string> = { port_visit: "P", gap: "G", loitering: "L", encounter: "E", fishing: "F" };
const CRUMB_LABEL: Record<string, string> = { port_visit: "Port visit", gap: "AIS gap", loitering: "Loitering", encounter: "Encounter", fishing: "Fishing" };

let selectedMmsi: number | null = null;
const EMPTY_FC = { type: "FeatureCollection", features: [] } as any;

function clearTrackSources(): void {
  for (const id of ["track", "gfw-track", "gfw-crumbs"]) {
    (map.getSource(id) as GeoJSONSource | undefined)?.setData(EMPTY_FC);
  }
}

function showCrumbDetail(p: { type: string; startTs: number; endTs: number | null }): void {
  const el = document.getElementById("gfw-detail");
  if (!el) return;
  el.innerHTML = `<b>${esc(CRUMB_LABEL[p.type] ?? p.type)}</b> — ${fmtTime(Number(p.startTs))}` +
    `${p.endTs ? ` → ${fmtTime(Number(p.endTs))}` : " · open"} <span class="gfw-src">(GFW)</span>`;
}

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
  selectedMmsi = mmsi;

  if (mmsi === null) {
    panel.hidden = true;
    clearTrackSources();
    return;
  }

  void Promise.all([fetchVessel(mmsi), fetchVesselTrack(mmsi, getWindow())]).then(([d, t]) => {
    if (selectedMmsi !== mmsi) return; // user selected another vessel while loading
    const body = document.getElementById("dossier-body")!;
    const identityEvents = d.events.filter((e) => e.type === "identity");
    const flag = flagForMmsi(d.vessel.mmsi);
    const v = d.vessel;
    const size = v.dimBow != null && v.dimStern != null && v.dimPort != null && v.dimStarboard != null
      ? `${v.dimBow + v.dimStern} × ${v.dimPort + v.dimStarboard} m` : "—";
    body.innerHTML = `
      <h2>${flag ? flag.flag + " " : ""}${esc(v.name) || "Unknown vessel"}</h2>
      <div class="score">${d.assessments.some((a) => a.status === "open") ? Math.round(Math.max(...d.assessments.filter((a) => a.status === "open").map((a) => a.confidence)) * 100) + "%" : "—"}</div>
      <div>MMSI ${v.mmsi} · ${esc(v.callsign) || "no callsign"} · ${v.sog} kn</div>
      <div>${flag ? esc(flag.country) : "Unknown flag"} · ${shipTypeLabel(v.shipType)} · ${REGION_LABEL[v.region ?? ""] ?? "—"}</div>
      <div>Destination: ${esc(v.destination) || "—"} · Size: ${size}</div>
      <div>Last seen ${fmtTime(v.lastTs)}</div>
      <h3>Threat assessments</h3>
      ${d.assessments.length ? d.assessments.map(renderAssessmentCard).join("") : "<div>No assessments</div>"}
      <h3>Detector breakdown</h3>
      <ul>${detectorBreakdown(d.events)}</ul>
      <h3>Identity history</h3>
      <ul>${identityEvents.length ? identityEvents.map((e) => `<li>${fmtTime(e.startTs)} — ${esc(JSON.stringify(e.evidence))}</li>`).join("") : "<li>No identity changes observed</li>"}</ul>
      <h3>Event timeline</h3>
      <ul>${d.events.length ? d.events.map((e) => `<li id="ev-${esc(e.id)}">${fmtTime(e.startTs)} — ${TYPE_LABEL[e.type] ?? e.type} (sev ${e.severity})${e.endTs === null ? " · ongoing" : ""}</li>`).join("") : "<li>No events</li>"}</ul>
      <div id="gfw-note" ${t.gfwError ? "" : "hidden"}>Deep history unavailable — GFW fetch failed</div>
      <div id="gfw-detail"></div>`;
    panel.hidden = false;
    body.querySelectorAll("a[data-event]").forEach((el) => el.addEventListener("click", (ev) => {
      ev.preventDefault();
      document.getElementById(`ev-${(el as HTMLElement).dataset.event}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }));

    clearTrackSources();
    const track = map.getSource("track") as GeoJSONSource | undefined;
    if (track && t.points.length > 1) {
      track.setData({ type: "Feature", properties: {},
        geometry: { type: "LineString", coordinates: t.points.map((p) => [p.lon, p.lat]) } } as any);
    }
    const crumbs: GfwBreadcrumb[] = t.gfwEvents; // already ascending by startTs
    (map.getSource("gfw-crumbs") as GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: crumbs.map((c) => ({
        type: "Feature", geometry: { type: "Point", coordinates: [c.lon, c.lat] },
        properties: { type: c.type, letter: CRUMB_LETTER[c.type] ?? "•", startTs: c.startTs, endTs: c.endTs },
      })),
    } as any);
    if (crumbs.length > 1) {
      (map.getSource("gfw-track") as GeoJSONSource | undefined)?.setData({
        type: "Feature", properties: {},
        geometry: { type: "LineString", coordinates: crumbs.map((c) => [c.lon, c.lat]) },
      } as any);
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

  // GFW breadcrumb trail for the selected vessel: dashed connector + typed letter markers.
  map.addSource("gfw-track", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addSource("gfw-crumbs", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "gfw-track", type: "line", source: "gfw-track",
    paint: { "line-color": "#b18cff", "line-width": 1.5, "line-dasharray": [2, 2], "line-opacity": 0.8 } }, "vessels");
  map.addLayer({ id: "gfw-crumb-dots", type: "circle", source: "gfw-crumbs",
    paint: { "circle-radius": 8, "circle-color": "#0b1220", "circle-stroke-color": "#b18cff", "circle-stroke-width": 1.5 } });
  map.addLayer({ id: "gfw-crumb-letters", type: "symbol", source: "gfw-crumbs",
    layout: { "text-field": ["get", "letter"], "text-size": 10, "text-allow-overlap": true },
    paint: { "text-color": "#b18cff" } });
  map.on("click", "gfw-crumb-dots", (e) => {
    const f = e.features?.[0];
    if (f) showCrumbDetail(f.properties as any);
  });
  map.on("mouseenter", "gfw-crumb-dots", () => { map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", "gfw-crumb-dots", () => { map.getCanvas().style.cursor = ""; });

  // Window switch refetches the selected vessel's track at the new depth.
  onWindowChange(() => { if (selectedMmsi !== null) selectVessel(selectedMmsi); });

  const chipsEl = document.getElementById("filter-chips")!;
  const allCats = ["All", "cable_interference", "dark_activity", "identity_deception"];
  let activeFilter: string | null = hashState.filter ?? null;

  function renderChips(): void {
    chipsEl.innerHTML = allCats.map((c) => {
      const label = c === "All" ? "All" : CATEGORY_LABEL[c] ?? c;
      const isActive = (c === "All" && !activeFilter) || activeFilter === c;
      return `<button data-type="${c}" class="${isActive ? "active" : ""}">${label}</button>`;
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
      const f = getDayFilter();
      const res = await fetchAssessments(getRegion(), getWindow());
      let items = res.assessments;
      if (f) items = items.filter((a) => a.openedTs >= f.startTs && a.openedTs < f.endTs);
      if (activeFilter) items = items.filter((a) => a.category === activeFilter);
      list.innerHTML = items.map(renderAssessmentItem).join("") ||
        `<li>${f ? `No assessments on ${f.day}` : "No open assessments"}</li>`;
    } catch (err) { console.error("assessment feed failed:", err); }
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
