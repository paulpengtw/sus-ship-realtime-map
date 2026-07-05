// web/src/timeline.ts — hand-rolled SVG severity histogram, last 14 days, active region (spec §3).
import type { DayBucket } from "./api";
import { getRegion, onRegionChange } from "./regions";
import { onStats } from "./stats";

const SEV_COLOR = ["#8b96a5", "#8b96a5", "#f0a83c", "#e5484d", "#e5484d"];
const W = 276, H = 36, GAP = 2;

let buckets: DayBucket[] = [];
let selected: string | null = null;
const listeners = new Set<() => void>();

export function getDayFilter(): { day: string; startTs: number; endTs: number } | null {
  if (!selected) return null;
  const startTs = Date.parse(`${selected}T00:00:00Z`);
  return { day: selected, startTs, endTs: startTs + 86_400_000 };
}

export function onDayFilter(fn: () => void): void { listeners.add(fn); }

function render(): void {
  const el = document.getElementById("timeline")!;
  if (!buckets.length) { el.innerHTML = ""; return; }
  const bw = (W - GAP * 13) / 14;
  const max = Math.max(1, ...buckets.map((b) => b.counts.reduce((a, c) => a + c, 0)));
  let bars = "";
  buckets.forEach((b, i) => {
    const x = i * (bw + GAP);
    let y = H;
    b.counts.forEach((c, sev) => {
      if (!c) return;
      const h = (c / max) * (H - 2);
      y -= h;
      bars += `<rect x="${x}" y="${y}" width="${bw}" height="${h}" fill="${SEV_COLOR[sev]}" rx="1"></rect>`;
    });
    if (b.day === selected) bars += `<rect class="selected-outline" x="${x - 0.5}" y="0.5" width="${bw + 1}" height="${H - 1}" rx="2"></rect>`;
    bars += `<rect class="day-hit" data-day="${b.day}" x="${x}" y="0" width="${bw}" height="${H}"><title>${b.day}: ${b.counts.reduce((a, c) => a + c, 0)} events</title></rect>`;
  });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${bars}</svg>` +
    `<div class="tl-caption"><span>${buckets[0].day.slice(5)}</span><span>${selected ? `filtering ${selected} · click again to clear` : "last 14 days"}</span><span>${buckets[13].day.slice(5)}</span></div>`;
}

export function initTimeline(): void {
  const el = document.getElementById("timeline")!;
  el.addEventListener("click", (e) => {
    const hit = (e.target as Element).closest<SVGRectElement>("rect.day-hit");
    if (!hit) return;
    selected = selected === hit.dataset.day ? null : hit.dataset.day!;
    render();
    for (const fn of listeners) fn();
  });
  onStats((s) => { buckets = s.histogram[getRegion()] ?? []; render(); });
  onRegionChange(() => { selected = null; for (const fn of listeners) fn(); });
}
