// web/src/assess.ts — category presentation + pure assessment rendering (testable without DOM).
import type { Assessment } from "./api";

export const CATEGORY_LABEL: Record<string, string> = {
  cable_interference: "Cable", dark_activity: "Dark", identity_deception: "Identity", militia_presence: "Militia",
};
export const CATEGORY_LONG: Record<string, string> = {
  cable_interference: "Cable interference", dark_activity: "Dark activity",
  identity_deception: "Identity deception", militia_presence: "Militia pattern",
};
export const CATEGORY_COLOR: Record<string, string> = {
  cable_interference: "#e5484d", dark_activity: "#b18cff", identity_deception: "#f0a83c", militia_presence: "#4cc3ff",
};

export const confidencePct = (c: number): string => `${Math.round(c * 100)}%`;

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const fmtTime = (ts: number) => new Date(ts).toISOString().replace("T", " ").slice(0, 16) + "Z";

export function renderAssessmentItem(a: Assessment): string {
  const color = CATEGORY_COLOR[a.category] ?? "#aab6c8";
  return `<li data-lon="${a.lastLon}" data-lat="${a.lastLat}" data-mmsi="${a.mmsi}">
    <span class="cat-badge" style="background:${color}">${CATEGORY_LABEL[a.category] ?? a.category}</span>
    <b>${confidencePct(a.confidence)}</b> — MMSI ${a.mmsi}${a.status === "open" ? " · ongoing" : ""}
    <div class="narrative">${esc(a.narrative)}</div>
    <time>${fmtTime(a.updatedTs)}</time></li>`;
}

export function renderAssessmentCard(a: Assessment): string {
  const color = CATEGORY_COLOR[a.category] ?? "#aab6c8";
  return `<div class="assess-card" style="border-left:3px solid ${color}">
    <div><span class="cat-badge" style="background:${color}">${esc(CATEGORY_LONG[a.category] ?? a.category)}</span>
      <b>${confidencePct(a.confidence)}</b> · ${a.status === "open" ? "ongoing" : `closed ${fmtTime(a.closedTs!)}`}</div>
    <div class="narrative">${esc(a.narrative)}</div>
    <ul>${a.evidence.map((e) => `<li><a href="#" data-event="${esc(e.eventId)}">${esc(e.summary)}</a></li>`).join("")}</ul>
  </div>`;
}
