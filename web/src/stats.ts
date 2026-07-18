// web/src/stats.ts — top-bar live stats for the active region; shares /api/stats with the timeline.
import { fetchStats, type StatsResponse } from "./api";
import { getRegion, onRegionChange } from "./regions";

let last: StatsResponse | null = null;
const listeners = new Set<(s: StatsResponse) => void>();

export function onStats(fn: (s: StatsResponse) => void): void {
  listeners.add(fn);
  if (last) fn(last);
}

function render(): void {
  const el = document.getElementById("stats-bar")!;
  const s = last?.regions[getRegion()];
  if (!s) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<span><b>${s.vessels}</b> vessels tracked</span>` +
    `<span><b>${s.activeAlerts}</b> open assessments</span>` +
    `<span><b>${s.events24h}</b> events / 24 h</span>`;
}

export function initStatsBar(): void {
  const poll = async () => {
    try {
      last = await fetchStats();
      render();
      for (const fn of listeners) fn(last);
    } catch (err) { console.error("stats failed:", err); }
  };
  onRegionChange(() => { render(); if (last) for (const fn of listeners) fn(last); });
  void poll();
  setInterval(poll, 30_000);
}
