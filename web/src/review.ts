// web/src/review.ts — Review-mode UI (spec §3c).
import maplibregl from "maplibre-gl";
import type { GeoJSONSource } from "maplibre-gl";
import { esc } from "./assess";
import { map } from "./main";
import {
  fetchLabelQueue, fetchLabelStats, fetchVessel, fetchVesselTrackRange, postLabel,
  type ApiCandidate, type ApiEvent, type PostLabelBody,
} from "./api";

let selected: ApiCandidate | null = null;
let queueCache: Map<string, ApiCandidate> = new Map();
const SOURCES = ["assessment", "event_cluster", "random_negative", "curated_positive"] as const;
const SOURCE_LABEL: Record<string, string> = {
  assessment: "Assessments", event_cluster: "Event clusters",
  random_negative: "Random negatives", curated_positive: "Curated positives",
};
const INTENT_LABELS: Record<string, string> = {
  cable_interference: "Cable interference",
  dark_activity: "Dark activity",
  identity_deception: "Identity deception",
};
const EMPTY = { type: "FeatureCollection", features: [] } as any;

function ensureReviewLayers(): void {
  if (map.getSource("review-track")) return;
  map.addSource("review-track", { type: "geojson", data: EMPTY });
  map.addSource("review-events", { type: "geojson", data: EMPTY });
  map.addLayer({ id: "review-track", type: "line", source: "review-track",
    paint: { "line-color": "#f0a83c", "line-width": 2.5, "line-opacity": 0.9 } }, "vessels");
  map.addLayer({ id: "review-events", type: "circle", source: "review-events",
    paint: { "circle-radius": 6, "circle-color": "#e5484d", "circle-stroke-color": "#0b1220", "circle-stroke-width": 1 } }, "sus-halo");
}

async function renderReplay(c: ApiCandidate): Promise<void> {
  ensureReviewLayers();
  const [track, dossier] = await Promise.all([
    fetchVesselTrackRange(Number(c.vesselId), c.tStart, c.tEnd),
    fetchVessel(Number(c.vesselId)),
  ]);
  const inWindow = (e: ApiEvent) => e.startTs <= c.tEnd && (e.endTs ?? c.tEnd) >= c.tStart;
  const events = dossier.events.filter(inWindow);
  (map.getSource("review-track") as GeoJSONSource).setData(
    track.points.length > 1
      ? { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: track.points.map((p) => [p.lon, p.lat]) } } as any
      : EMPTY,
  );
  (map.getSource("review-events") as GeoJSONSource).setData({
    type: "FeatureCollection",
    features: events.map((e) => ({
      type: "Feature", geometry: { type: "Point", coordinates: [e.lon, e.lat] },
      properties: { id: e.id, type: e.type },
    })),
  } as any);
  if (track.points.length) {
    const b = new maplibregl.LngLatBounds();
    for (const p of track.points) b.extend([p.lon, p.lat]);
    if (!b.isEmpty()) map.fitBounds(b, { padding: 60, animate: true, maxZoom: 12 });
  }
  renderForm(c);
}

function renderForm(c: ApiCandidate): void {
  const panel = document.getElementById("dossier")!;
  const body = document.getElementById("dossier-body")!;
  const labeler = localStorage.getItem("reviewLabeler") ?? "";
  body.innerHTML = `
    <h2>Label incident</h2>
    <div>MMSI ${esc(c.vesselId)} · ${new Date(c.tStart).toISOString().slice(0, 16).replace("T", " ")}Z → ${new Date(c.tEnd).toISOString().slice(0, 16).replace("T", " ")}Z</div>
    <div>Source: ${esc(c.source)} ${c.sourceRef ? `(${esc(c.sourceRef)})` : ""}</div>
    <form id="review-form">
      <label>Labeler <input name="labeler" required value="${esc(labeler)}"></label>
      <fieldset><legend>Verdict</legend>
        ${["threat", "suspicious", "benign", "unclear"].map((v) =>
          `<label><input type="radio" name="verdict" value="${esc(v)}" required> ${esc(v)}</label>`).join("")}
      </fieldset>
      <fieldset id="intent-fs" disabled>
        <legend>Intent categories</legend>
        ${Object.entries(INTENT_LABELS).map(([k, v]) =>
          `<label><input type="checkbox" name="intent" value="${esc(k)}"> ${esc(v)}</label>`).join("")}
      </fieldset>
      <label>Confidence
        <input type="range" name="confidence" min="1" max="5" value="3">
      </label>
      <label>Notes<textarea name="notes"></textarea></label>
      <button type="submit">Save &amp; next</button>
    </form>`;
  panel.hidden = false;
  const form = body.querySelector("#review-form") as HTMLFormElement;
  const intentFs = body.querySelector("#intent-fs") as HTMLFieldSetElement;
  form.addEventListener("change", () => {
    const v = (form.elements.namedItem("verdict") as RadioNodeList).value;
    intentFs.disabled = !(v === "threat" || v === "suspicious");
    if (intentFs.disabled) {
      intentFs.querySelectorAll<HTMLInputElement>("input[name=intent]").forEach((el) => (el.checked = false));
    }
  });
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const fd = new FormData(form);
    const verdict = fd.get("verdict") as PostLabelBody["verdict"];
    const labelerVal = String(fd.get("labeler") ?? "");
    if (!labelerVal) return;
    localStorage.setItem("reviewLabeler", labelerVal);
    const intents = (fd.getAll("intent") as string[]).filter(Boolean);
    const notes = String(fd.get("notes") ?? "").trim();
    const submitBody: PostLabelBody = {
      incidentId: c.id, labeler: labelerVal, verdict,
      labelerConfidence: Number(fd.get("confidence")),
    };
    if (notes.length > 0) submitBody.notes = notes;
    if (verdict === "threat" || verdict === "suspicious") submitBody.intentCategories = intents;
    const res = await postLabel(submitBody);
    if ("error" in res) { alert(`save failed: ${res.error}`); return; }
    await renderQueue();
    const { candidates } = await fetchLabelQueue(c.source, 1);
    if (candidates[0]) selectReviewIncident(candidates[0]);
    else {
      document.getElementById("dossier")!.hidden = true;
      (map.getSource("review-track") as GeoJSONSource).setData(EMPTY);
      (map.getSource("review-events") as GeoJSONSource).setData(EMPTY);
    }
  });
}

async function renderQueue(): Promise<void> {
  const list = document.getElementById("event-list")!;
  const [stats, perSource] = await Promise.all([
    fetchLabelStats(),
    Promise.all(SOURCES.map((s) => fetchLabelQueue(s, 10))),
  ]);
  queueCache = new Map(perSource.flatMap((x) => x.candidates).map((c) => [c.id, c]));
  const parts: string[] = [];
  for (let i = 0; i < SOURCES.length; i++) {
    const s = SOURCES[i];
    const { total, labeled } = stats.bySource[s];
    const { candidates } = perSource[i];
    parts.push(
      `<li class="review-header"><b>${esc(SOURCE_LABEL[s])}</b> ${labeled}/${total}</li>`,
      ...candidates.map((c) => `
        <li data-incident="${esc(c.id)}" data-mmsi="${esc(c.vesselId)}" data-tstart="${c.tStart}" data-tend="${c.tEnd}" class="review-row">
          MMSI ${esc(c.vesselId)} · ${new Date(c.tStart).toISOString().slice(0, 16).replace("T", " ")}Z
          <span class="review-source">${esc(SOURCE_LABEL[s])}</span>
        </li>`),
    );
  }
  list.innerHTML = parts.join("");
  list.querySelectorAll("li.review-row").forEach((el) => el.addEventListener("click", async () => {
    const id = (el as HTMLElement).dataset.incident!;
    const c = await lookupById(id);
    if (c) selectReviewIncident(c);
  }));
  const chips = document.getElementById("filter-chips");
  if (chips) chips.innerHTML = `<span class="review-badge">Review mode · imbalance ${stats.imbalance.threatVsBenign.toFixed(2)}</span>`;
}

async function lookupById(id: string): Promise<ApiCandidate | null> {
  return queueCache.get(id) ?? null;
}

export function selectReviewIncident(c: ApiCandidate): void {
  selected = c;
  window.dispatchEvent(new CustomEvent("review-incident", { detail: c }));
}
export function getSelectedReview(): ApiCandidate | null { return selected; }

export function initReviewMode(): void {
  document.body.classList.add("mode-review");
  void renderQueue();
  window.addEventListener("review-incident", ((ev: CustomEvent<ApiCandidate>) => { void renderReplay(ev.detail); }) as EventListener);
}
