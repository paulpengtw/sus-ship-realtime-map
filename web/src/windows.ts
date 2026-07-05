// web/src/windows.ts — active history window: mirrors regions.ts (localStorage persistence + listeners).
export interface WindowDef { id: string; label: string }

export const WINDOWS: WindowDef[] = [
  { id: "day", label: "Day" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "3m", label: "3M" },
  { id: "6m", label: "6M" },
];
export const DEFAULT_WINDOW = "month";
export const WINDOW_STORE_KEY = "cg-window";

export function resolveInitialWindow(stored: string | null): string {
  return WINDOWS.some((w) => w.id === stored) ? (stored as string) : DEFAULT_WINDOW;
}

let current = resolveInitialWindow(typeof localStorage === "undefined" ? null : localStorage.getItem(WINDOW_STORE_KEY));
const listeners = new Set<(id: string) => void>();

export const getWindow = (): string => current;

export function setWindow(id: string): void {
  if (!WINDOWS.some((w) => w.id === id)) return;
  localStorage.setItem(WINDOW_STORE_KEY, id);
  if (id === current) return;
  current = id;
  for (const fn of listeners) fn(id);
}

export function onWindowChange(fn: (id: string) => void): void { listeners.add(fn); }
