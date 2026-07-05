// web/src/onboarding.ts — first-visit intro modal + hand-rolled 5-step spotlight tour (spec §4).
import { REGIONS } from "./regions";
import { activateRegion } from "./switcher";

const SEEN_KEY = "cg-intro-seen";

const TOUR: { sel: string; title: string; text: string }[] = [
  { sel: "#region-switcher", title: "Pick your region",
    text: "Korea, Taiwan and Japan are monitored simultaneously. Switching regions moves the map and filters the stats, timeline and event feed — the choice is remembered for next time." },
  { sel: "#legend", title: "Reading the map",
    text: "Vessel dots are colored by suspicion score. Dashed cyan lines are approximate cable corridors; purple hollow circles are delayed Global Fishing Watch confirmations." },
  { sel: "#map", title: "Live vessels",
    text: "Every dot is a live AIS position near a cable-landing corridor, refreshed every 15 seconds. Grey is normal; amber and red vessels have triggered anomaly detectors." },
  { sel: "#event-feed", title: "Events & timeline",
    text: "Anomalies (loitering, AIS gaps, identity changes, anchor dragging) appear here as they happen. The bar strip shows the last 14 days — click a day to filter." },
  { sel: "#map", title: "Vessel dossier",
    text: "Click any vessel dot to open its dossier: flag, ship type, destination, track history and every detector hit. Try it once the tour ends!" },
];

function el(html: string): HTMLElement {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
}

function showTourStep(i: number): void {
  document.getElementById("tour-overlay")?.remove();
  if (i >= TOUR.length) return;
  const step = TOUR[i];
  const target = document.querySelector(step.sel);
  if (!target) { showTourStep(i + 1); return; }
  const r = target.getBoundingClientRect();
  const overlay = el(`<div id="tour-overlay">
      <div class="tour-spot" style="left:${r.left - 6}px;top:${r.top - 6}px;width:${r.width + 12}px;height:${r.height + 12}px"></div>
      <div class="tour-tip">
        <h3>${step.title}</h3><p>${step.text}</p>
        <div class="tour-nav">
          <span>${i + 1} / ${TOUR.length}</span>
          <button class="tour-skip">Skip</button>
          <button class="tour-next">${i === TOUR.length - 1 ? "Done" : "Next"}</button>
        </div>
      </div>
    </div>`);
  const tip = overlay.querySelector<HTMLElement>(".tour-tip")!;
  const below = r.bottom + 12 + 160 < innerHeight;
  tip.style.top = below ? `${r.bottom + 12}px` : "auto";
  if (!below) tip.style.bottom = `${innerHeight - r.top + 12}px`;
  tip.style.left = `${Math.max(12, Math.min(r.left, innerWidth - 332))}px`;
  overlay.querySelector(".tour-next")!.addEventListener("click", () => showTourStep(i + 1));
  overlay.querySelector(".tour-skip")!.addEventListener("click", () => overlay.remove());
  document.body.appendChild(overlay);
}

function showIntro(): void {
  document.getElementById("intro-modal")?.remove();
  const modal = el(`<div id="intro-modal">
      <div class="intro-card">
        <h2>East Asia Cable Guard</h2>
        <p>Real-time detection of suspicious ship behavior near submarine cable corridors in Korea, Taiwan and Japan.</p>
        <p><b>Why it matters:</b> East Asia has seen a string of cable-cutting incidents — anchors dragged across corridors,
        ships loitering over landing approaches, vessels going dark. This map watches live AIS traffic for exactly those patterns.</p>
        <p><b>Data:</b> live AIS via AISStream.io; delayed corroboration from Global Fishing Watch; cable routes are approximate public corridors.</p>
        <p><b>Reading the map:</b> grey dots are normal vessels; amber and red have triggered anomaly detectors. Dashed lines are cable corridors.</p>
        <h3>Start in your region</h3>
        <div class="intro-regions">${REGIONS.map((r) => `<button data-region="${r.id}">${r.name}</button>`).join("")}</div>
        <button class="intro-tour">Take a tour</button>
      </div>
    </div>`);
  modal.querySelectorAll<HTMLElement>(".intro-regions button").forEach((b) =>
    b.addEventListener("click", () => {
      localStorage.setItem(SEEN_KEY, "1");
      activateRegion(b.dataset.region!);
      modal.remove();
    }));
  modal.querySelector(".intro-tour")!.addEventListener("click", () => {
    localStorage.setItem(SEEN_KEY, "1");
    modal.remove();
    showTourStep(0);
  });
  document.body.appendChild(modal);
}

export function initOnboarding(): void {
  document.getElementById("help-btn")!.addEventListener("click", showIntro);
  if (!localStorage.getItem(SEEN_KEY)) showIntro();
}
