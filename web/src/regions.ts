// web/src/regions.ts — active region: mirror of CONFIG.regions camera presets + localStorage persistence.
export interface RegionDef { id: string; name: string; center: [number, number]; zoom: number }

export const REGIONS: RegionDef[] = [
  { id: "kr", name: "Korea", center: [127.5, 35.0], zoom: 6.3 },
  { id: "tw", name: "Taiwan", center: [120.9, 23.7], zoom: 6.3 },
  { id: "jp", name: "Japan", center: [135.5, 34.5], zoom: 5.8 },
];
export const DEFAULT_REGION = "kr";
export const STORE_KEY = "cg-region";

export function resolveInitialRegion(stored: string | null): string {
  return REGIONS.some((r) => r.id === stored) ? (stored as string) : DEFAULT_REGION;
}

let current = resolveInitialRegion(typeof localStorage === "undefined" ? null : localStorage.getItem(STORE_KEY));
const listeners = new Set<(id: string) => void>();

export const getRegion = (): string => current;
export const regionDef = (id: string): RegionDef => REGIONS.find((r) => r.id === id)!;

export function setRegion(id: string): void {
  if (!REGIONS.some((r) => r.id === id)) return;
  localStorage.setItem(STORE_KEY, id);
  if (id === current) return;
  current = id;
  for (const fn of listeners) fn(id);
}

export function onRegionChange(fn: (id: string) => void): void { listeners.add(fn); }
