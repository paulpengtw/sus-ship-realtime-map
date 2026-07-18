import { THREAT_CATEGORIES, type ThreatCategory } from "../../src/types";

export const CATEGORY_COLOR: Record<ThreatCategory, string> = {
  cable_interference: "#e5484d",
  dark_activity: "#b18cff",
  identity_deception: "#f0a83c",
};

export const CAT_COLOR = THREAT_CATEGORIES.map((c) => CATEGORY_COLOR[c]);

export const CAT_MATCH = ["match", ["coalesce", ["get", "topCategory"], ""],
  ...THREAT_CATEGORIES.flatMap((c) => [c, CATEGORY_COLOR[c]]),
  "#aab6c8",
] as unknown as any;
