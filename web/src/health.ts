// web/src/health.ts — pure state derivation so it is unit-testable; DOM writes live in vessels.ts.
export interface HealthView {
  bannerHidden: boolean;
  bannerText: string;
  chipLive: boolean;  // true → green "live" styling, false → amber "stale" styling
  chipText: string;
}

export function healthView(newestTs: number | null, vesselCount: number, now: number, staleMs: number): HealthView {
  if (newestTs === null) {
    return { bannerHidden: false, bannerText: "⚠ no vessel data received yet — ingest may be down",
             chipLive: false, chipText: "● no data" };
  }
  if (now - newestTs > staleMs) {
    const t = new Date(newestTs);
    const hhmm = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
    return { bannerHidden: false, bannerText: `⚠ data stale since ${hhmm}`,
             chipLive: false, chipText: `● stale — ${vesselCount} vessels` };
  }
  return { bannerHidden: true, bannerText: "", chipLive: true, chipText: `● live — ${vesselCount} vessels` };
}
