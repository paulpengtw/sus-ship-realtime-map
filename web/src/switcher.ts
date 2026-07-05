// web/src/switcher.ts — region pills: camera preset + region filter + persistence.
import { map } from "./main";
import { getRegion, onRegionChange, regionDef, setRegion } from "./regions";
import { getWindow, onWindowChange, setWindow } from "./windows";

export function activateRegion(id: string): void {
  setRegion(id);
  const r = regionDef(id);
  map.flyTo({ center: r.center, zoom: r.zoom });
}

export function initRegionSwitcher(): void {
  const nav = document.getElementById("region-switcher")!;
  const paint = () => nav.querySelectorAll<HTMLButtonElement>("button[data-region]")
    .forEach((b) => b.classList.toggle("active", b.dataset.region === getRegion()));
  nav.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("button[data-region]");
    if (btn) activateRegion(btn.dataset.region!);
  });
  onRegionChange(paint);
  paint();
}

export function initWindowSwitcher(): void {
  const nav = document.getElementById("window-switcher")!;
  const paint = () => nav.querySelectorAll<HTMLButtonElement>("button[data-window]")
    .forEach((b) => b.classList.toggle("active", b.dataset.window === getWindow()));
  nav.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("button[data-window]");
    if (btn) setWindow(btn.dataset.window!);
  });
  onWindowChange(paint);
  paint();
}
