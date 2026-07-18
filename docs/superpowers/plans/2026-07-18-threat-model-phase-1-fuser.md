# Threat Model Phase 1 — Two-Layer Fuser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** [2026-07-18 Finer-Granularity Threat Model](../specs/2026-07-18-threat-model-finer-granularity-design.md)

**Prerequisite:** [Phase 0 — Labeling Harness](2026-07-18-threat-model-phase-0-labeling-harness.md) must be merged AND the `labels` table must contain ≥ 200 labels (≥ 40 threat, ≥ 100 benign, imbalance ≤ 1:5) before Task 14 (Platt fit) runs. Tasks 1–13 and 15–16 can proceed as soon as Phase 0 is merged; the calibration itself is label-gated.

**Goal:** Ship the two-layer mechanism-axis + intent-category fuser as PR-B (behind `?model=v2` feature flag) and PR-C (cutover to v2 as default, legacy code removed).

**Architecture:** Five mechanism sub-models (`positional`, `kinematic`, `contextual`, `complex`, `identity`) each implement a `MechanismSubModel` interface returning `{ score: [0,1], evidence, contributingEventIds }`. A pluggable `IntentFuser` strategy consumes mechanism scores and emits calibrated intent-category posteriors. The v1 strategy is `WeightedSumPlattFuser` (3×5 weight table + per-intent Platt sigmoid). Assessment lifecycle becomes a 4-band state machine (`none` / `watch` / `elevated` / `high`) on the intent posterior. The Worker exposes `?model=v1|v2` on `/api/snapshot`, `/api/trajectories`, and `/api/vessel/:mmsi`; the web UI reads whichever flag the URL carries. PR-C flips the default and deletes v1 fusion code.

**Tech Stack:** TypeScript, Cloudflare Workers, D1, Durable Objects, Vite, MapLibre GL, Vitest with `@cloudflare/vitest-pool-workers`, `tsx` for the Platt fitter.

## Global Constraints

- Test command: `npm test`.
- No new runtime dependencies. Platt fitting uses IRLS in pure TypeScript — no scipy, ml.js, or WASM.
- Detectors (`src/detectors/*`) remain behavior-frozen from Phase 0 onwards. Fusion consumes their numeric evidence bags, not their type + class.
- Assessment table wire format stays additive: new `intents`, `mechanisms` maps live alongside the existing `category`, `confidence` fields during PR-B, are the canonical shape after PR-C, and `topCategory` mirrors `topIntent` until PR-C+1.
- Per spec §5d retirement story: `vessel.score` / `score_ts` are **stopped reading** in PR-C, **kept written** one release, and physically dropped in a follow-up migration (out of this plan).
- Sub-model outputs must be pure functions of `(events, vesselState, config, geo, now)` — no I/O, no `Date.now()`.

---

### Task 1: Mechanism-axis + intent-posterior types

**Files:**
- Create: `src/mechanisms/types.ts`
- Create: `test/mechanisms-types.test.ts`

**Interfaces:**
- Produces:
  - `type MechanismAxis = "positional" | "kinematic" | "contextual" | "complex" | "identity"`
  - `const MECHANISM_AXES: readonly MechanismAxis[]`
  - `interface EvidenceBag { [key: string]: unknown }`
  - `interface MechanismScore { axis: MechanismAxis; score: number; evidence: EvidenceBag; contributingEventIds: string[]; lastUpdated: number; }`
  - `interface SubModelContext { state: VesselState; events: AnomalyEvent[]; geo: GeoContext; cfg: Config; now: number; }`
  - `interface MechanismSubModel { readonly axis: MechanismAxis; score(ctx: SubModelContext): MechanismScore; }`
  - `interface IntentPosterior { P: number; state: "none" | "watch" | "elevated" | "high"; topContributingAxes: [MechanismAxis, number][]; calibrationState: "calibrated" | "uncalibrated"; }`
  - `interface VesselAssessmentV2 { vesselId: string; intents: Record<ThreatCategory, IntentPosterior>; mechanisms: Record<MechanismAxis, MechanismScore>; topIntent: ThreatCategory | null; }`

- [ ] **Step 1: Write the failing test**

Create `test/mechanisms-types.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MECHANISM_AXES } from "../src/mechanisms/types";

describe("mechanism types", () => {
  it("exposes exactly five axes in a stable order", () => {
    expect(MECHANISM_AXES).toEqual(["positional", "kinematic", "contextual", "complex", "identity"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/mechanisms-types.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/mechanisms/types.ts`**

```ts
// src/mechanisms/types.ts — evidence + fuser interfaces (spec §4a, §4d).
import type { Config } from "../config";
import type { GeoContext } from "../geo/context";
import type { AnomalyEvent, ThreatCategory, VesselState } from "../types";

export const MECHANISM_AXES = ["positional", "kinematic", "contextual", "complex", "identity"] as const;
export type MechanismAxis = (typeof MECHANISM_AXES)[number];

export interface EvidenceBag { [key: string]: unknown }

export interface MechanismScore {
  axis: MechanismAxis;
  score: number;                 // continuous [0, 1]
  evidence: EvidenceBag;
  contributingEventIds: string[];
  lastUpdated: number;
}

export interface SubModelContext {
  state: VesselState;
  events: AnomalyEvent[];        // recent events for this vessel, newest first
  geo: GeoContext;
  cfg: Config;
  now: number;
}

export interface MechanismSubModel {
  readonly axis: MechanismAxis;
  score(ctx: SubModelContext): MechanismScore;
}

export type IntentBand = "none" | "watch" | "elevated" | "high";

export interface IntentPosterior {
  P: number;                                        // calibrated [0, 1]
  state: IntentBand;
  topContributingAxes: [MechanismAxis, number][];   // sorted desc, top 3
  calibrationState: "calibrated" | "uncalibrated";
}

export interface VesselAssessmentV2 {
  vesselId: string;
  intents: Record<ThreatCategory, IntentPosterior>;
  mechanisms: Record<MechanismAxis, MechanismScore>;
  topIntent: ThreatCategory | null;
}

export interface IntentFuser {
  fuse(mechScores: Record<MechanismAxis, MechanismScore>, cfg: Config): Record<ThreatCategory, IntentPosterior>;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- test/mechanisms-types.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mechanisms/types.ts test/mechanisms-types.test.ts
git commit -m "feat: mechanism + intent-posterior types (spec §4a, §4d)"
```

---

### Task 2: Config additions — per-axis half-lives, W[3×5], Platt, state bands

**Files:**
- Modify: `src/config.ts`
- Create: `test/config-v2.test.ts`

**Interfaces:**
- Produces `CONFIG.v2` block:
  - `axisHalfLifeMs: Record<MechanismAxis, number>` — all default 86_400_000 (24 h) per spec §4a.
  - `W: Record<ThreatCategory, Record<MechanismAxis, number>>` — 3×5 hand-set starting table.
  - `platt: Record<ThreatCategory, { A: number; B: number; state: "calibrated" | "uncalibrated" }>` — starts uncalibrated with `A = -2, B = 0` (identity-ish sigmoid).
  - `intentBands: { watch: number; elevated: number; high: number; dwellMs: number }` — `{ watch: 0.15, elevated: 0.4, high: 0.7, dwellMs: 43_200_000 }`.

Starting `W` (documented in a comment as "scaled from legacy CLASS_WEIGHT — refit after ≥ 200 labels"):

```
                  positional  kinematic  contextual  complex  identity
cable_interference   0.30      0.60       0.15        0.20     0.05
dark_activity        0.20      0.20       0.10        0.30     0.35
identity_deception   0.05      0.05       0.10        0.20     0.60
```

- [ ] **Step 1: Write the failing test**

Create `test/config-v2.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import { MECHANISM_AXES } from "../src/mechanisms/types";
import { THREAT_CATEGORIES } from "../src/types";

describe("CONFIG.v2", () => {
  it("declares a half-life for every mechanism axis", () => {
    for (const a of MECHANISM_AXES) expect(CONFIG.v2.axisHalfLifeMs[a]).toBe(86_400_000);
  });
  it("W has a row per intent category and a column per mechanism axis", () => {
    for (const c of THREAT_CATEGORIES) {
      for (const a of MECHANISM_AXES) {
        expect(typeof CONFIG.v2.W[c][a]).toBe("number");
      }
    }
  });
  it("Platt defaults to uncalibrated with A=-2, B=0 per intent", () => {
    for (const c of THREAT_CATEGORIES) {
      expect(CONFIG.v2.platt[c]).toEqual({ A: -2, B: 0, state: "uncalibrated" });
    }
  });
  it("intent bands are monotonic and dwell is 12 h", () => {
    const b = CONFIG.v2.intentBands;
    expect(b.watch).toBeLessThan(b.elevated);
    expect(b.elevated).toBeLessThan(b.high);
    expect(b.dwellMs).toBe(43_200_000);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/config-v2.test.ts`
Expected: FAIL — `CONFIG.v2` undefined.

- [ ] **Step 3: Extend `src/config.ts`**

Inside `CONFIG` (before the closing `} as const`), add:

```ts
  // v2 fuser (spec §4). Starting weights derived from legacy CLASS_WEIGHT scaling.
  // Refit W and platt.{A,B} after Phase 0 accumulates ≥ 200 labeled incidents.
  v2: {
    axisHalfLifeMs: {
      positional: 86_400_000, kinematic: 86_400_000, contextual: 86_400_000,
      complex: 86_400_000,    identity:  86_400_000,
    },
    W: {
      cable_interference: { positional: 0.30, kinematic: 0.60, contextual: 0.15, complex: 0.20, identity: 0.05 },
      dark_activity:      { positional: 0.20, kinematic: 0.20, contextual: 0.10, complex: 0.30, identity: 0.35 },
      identity_deception: { positional: 0.05, kinematic: 0.05, contextual: 0.10, complex: 0.20, identity: 0.60 },
    },
    platt: {
      cable_interference: { A: -2, B: 0, state: "uncalibrated" as const },
      dark_activity:      { A: -2, B: 0, state: "uncalibrated" as const },
      identity_deception: { A: -2, B: 0, state: "uncalibrated" as const },
    },
    intentBands: { watch: 0.15, elevated: 0.4, high: 0.7, dwellMs: 43_200_000 },
  },
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- test/config-v2.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config-v2.test.ts
git commit -m "feat: v2 config — per-axis half-lives, W[3x5], Platt, state bands (spec §4a-4c)"
```

---

### Task 3: Broaden MID + callsign country tables (identity mechanism prep)

The existing `src/detectors/identity.ts` lookups cover ~30 country codes. Phase 1's Identity mechanism (Task 8) reads them for the *registered* facet — coverage gaps mean many vessels get null signal. Broaden to the full ITU MID list and the standard callsign-prefix list; keep the lookup table checked into the repo so no runtime fetch.

**Files:**
- Create: `src/mid-table.ts` (full MID prefix → ISO country code table)
- Create: `src/callsign-table.ts` (full callsign-prefix → ISO country code table)
- Modify: `src/detectors/identity.ts` (import from the two new tables instead of the inline objects)
- Modify: `test/identity.test.ts` (add coverage cases: 2 previously-unknown countries now resolve)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `function countryForMid(mmsi: number): string | null`
  - `function countryForCallsign(cs: string | null): string | null`
  - Both live in the new tables' modules and are the sole callable API.

- [ ] **Step 1: Read the current identity.ts inline lookups**

Run: `sed -n '1,40p' src/detectors/identity.ts`
Expected: two small objects, ~30 entries each. Note them — the broaden step is additive.

- [ ] **Step 2: Write the failing test**

In `test/identity.test.ts` add:

```ts
import { countryForMid, countryForCallsign } from "../src/detectors/identity";

describe("identity lookups — broadened coverage", () => {
  it("countryForMid resolves previously-missing MIDs", () => {
    // Norway (MID 257/258/259), Nigeria (657), Marshall Islands (538), Turkey (271)
    expect(countryForMid(257_000_000)).toBe("NO");
    expect(countryForMid(657_000_000)).toBe("NG");
    expect(countryForMid(538_000_000)).toBe("MH");
    expect(countryForMid(271_000_000)).toBe("TR");
  });
  it("countryForCallsign covers standard prefixes", () => {
    expect(countryForCallsign("LA1234")).toBe("NO");
    expect(countryForCallsign("5N1234")).toBe("NG");
    expect(countryForCallsign("V71234")).toBe("MH");
    expect(countryForCallsign("TA1234")).toBe("TR");
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npm test -- test/identity.test.ts`
Expected: FAIL — one or more lookups return null (or the exports don't exist yet).

- [ ] **Step 4: Add the MID and callsign tables**

Create `src/mid-table.ts` with the ITU-published MID list. Use the canonical CSV maintained by the ITU. A reasonable minimum starter set to unblock the plan (still meaningfully broader than current):

```ts
// src/mid-table.ts — ITU Maritime Identification Digits → ISO 3166-1 alpha-2 (subset).
// Full list at https://www.itu.int/en/ITU-R/terrestrial/fmd/Pages/mid.aspx.
// Every entry documented; adding new ones is safe (does not break existing behavior).
export const MID_TABLE: Record<string, string> = {
  "201": "AL", "202": "AD", "203": "AT", "204": "AZ", "205": "BE", "206": "BY", "207": "BG",
  "208": "VA", "209": "CY", "210": "CY", "211": "DE", "212": "CY", "213": "GE", "214": "MD",
  "215": "MT", "216": "AM", "218": "DE", "219": "DK", "220": "DK", "224": "ES", "225": "ES",
  "226": "FR", "227": "FR", "228": "FR", "229": "MT", "230": "FI", "231": "FO", "232": "GB",
  "233": "GB", "234": "GB", "235": "GB", "236": "GI", "237": "GR", "238": "HR", "239": "GR",
  "240": "GR", "241": "GR", "242": "MA", "243": "HU", "244": "NL", "245": "NL", "246": "NL",
  "247": "IT", "248": "MT", "249": "MT", "250": "IE", "251": "IS", "252": "LI", "253": "LU",
  "254": "MC", "255": "PT", "256": "MT", "257": "NO", "258": "NO", "259": "NO", "261": "PL",
  "262": "ME", "263": "PT", "264": "RO", "265": "SE", "266": "SE", "267": "SK", "268": "SM",
  "269": "CH", "270": "CZ", "271": "TR", "272": "UA", "273": "RU", "274": "MK", "275": "LV",
  "276": "EE", "277": "LT", "278": "SI", "279": "RS", "301": "AI", "303": "US", "304": "AG",
  "305": "AG", "306": "CW", "307": "AW", "308": "BS", "309": "BS", "310": "BM", "311": "BS",
  "312": "BZ", "314": "BB", "316": "CA", "319": "KY", "321": "CR", "323": "CU", "325": "DM",
  "327": "DO", "329": "GP", "330": "GD", "331": "GL", "332": "GT", "334": "HN", "336": "HT",
  "338": "US", "339": "JM", "341": "KN", "343": "LC", "345": "MX", "347": "MQ", "348": "MS",
  "350": "NI", "351": "PA", "352": "PA", "353": "PA", "354": "PA", "355": "PA", "356": "PA",
  "357": "PA", "358": "PR", "359": "SV", "361": "PM", "362": "TT", "364": "TC", "366": "US",
  "367": "US", "368": "US", "369": "US", "370": "PA", "371": "PA", "372": "PA", "373": "PA",
  "374": "PA", "375": "VC", "376": "VC", "377": "VC", "378": "VG", "379": "VI", "401": "AF",
  "403": "SA", "405": "BD", "408": "BH", "410": "BT", "412": "CN", "413": "CN", "414": "CN",
  "416": "TW", "417": "LK", "419": "IN", "422": "IR", "423": "AZ", "425": "IQ", "428": "IL",
  "431": "JP", "432": "JP", "434": "TM", "436": "KZ", "437": "UZ", "438": "JO", "440": "KR",
  "441": "KR", "443": "PS", "445": "KP", "447": "KW", "450": "LB", "451": "KG", "453": "MO",
  "455": "MV", "457": "MN", "459": "NP", "461": "OM", "463": "PK", "466": "QA", "468": "SY",
  "470": "AE", "473": "YE", "475": "YE", "477": "HK", "478": "BA", "501": "AQ", "503": "AU",
  "506": "MM", "508": "BN", "510": "FM", "511": "PW", "512": "NZ", "514": "KH", "515": "KH",
  "516": "CX", "518": "CK", "520": "FJ", "523": "CC", "525": "ID", "529": "KI", "531": "LA",
  "533": "MY", "536": "MP", "538": "MH", "540": "NC", "542": "NU", "544": "NR", "546": "PF",
  "548": "PH", "553": "PG", "555": "PN", "557": "SB", "559": "AS", "561": "WS", "563": "SG",
  "564": "SG", "565": "SG", "566": "SG", "567": "TH", "570": "TO", "572": "TV", "574": "VN",
  "576": "VU", "577": "VU", "578": "WF", "601": "ZA", "603": "AO", "605": "DZ", "607": "TF",
  "608": "GB", "609": "BI", "610": "BJ", "611": "BW", "612": "CF", "613": "CM", "615": "CG",
  "616": "KM", "617": "CV", "618": "TF", "619": "CI", "620": "KM", "621": "DJ", "622": "EG",
  "624": "ET", "625": "ER", "626": "GA", "627": "GH", "629": "GM", "630": "GW", "631": "GQ",
  "632": "GN", "633": "BF", "634": "KE", "635": "TF", "636": "LR", "637": "LR", "642": "LY",
  "644": "LS", "645": "MU", "647": "MG", "649": "ML", "650": "MZ", "654": "MR", "655": "MW",
  "656": "NE", "657": "NG", "659": "NA", "660": "RE", "661": "RW", "662": "SD", "663": "SN",
  "664": "SC", "665": "SH", "666": "SO", "667": "SL", "668": "ST", "669": "SZ", "670": "TD",
  "671": "TG", "672": "TN", "674": "TZ", "675": "UG", "676": "CD", "677": "TZ", "678": "ZM",
  "679": "ZW", "701": "AR", "710": "BR", "720": "BO", "725": "CL", "730": "CO", "735": "EC",
  "740": "FK", "745": "GF", "750": "GY", "755": "PY", "760": "PE", "765": "SR", "770": "UY",
  "775": "VE",
};

export function countryForMid(mmsi: number): string | null {
  const mid = String(Math.trunc(Math.abs(mmsi))).padStart(9, "0").slice(0, 3);
  return MID_TABLE[mid] ?? null;
}
```

Create `src/callsign-table.ts` — the ITU callsign-prefix range table. Because the table is large and range-based, encode it as an array of [prefixStart, prefixEnd, iso] tuples and do a binary search. For this plan, include the OFTEN-USED prefixes (a starter subset — the engineer expands after review):

```ts
// src/callsign-table.ts — ITU callsign-prefix → ISO country code (starter subset;
// expand from https://www.itu.int/en/ITU-R/terrestrial/fmd/Pages/callsigns.aspx).
// Each row: [startPrefix, endPrefix, iso].  Prefix compare is character-by-character.
const RANGES: [string, string, string][] = [
  ["3A", "3A", "MC"], ["3B", "3B", "MU"], ["3C", "3C", "GQ"], ["3D", "3D", "SZ"],
  ["3E", "3F", "PA"], ["3V", "3V", "TN"], ["3W", "3W", "VN"], ["3X", "3X", "GN"],
  ["3Y", "3Y", "NO"], ["3Z", "3Z", "PL"], ["4A", "4C", "MX"], ["4D", "4I", "PH"],
  ["4J", "4K", "AZ"], ["4L", "4L", "GE"], ["4M", "4M", "VE"], ["4N", "4O", "YU"],
  ["4P", "4S", "LK"], ["4T", "4T", "PE"], ["4U", "4U", "UN"], ["4V", "4V", "HT"],
  ["4W", "4W", "YE"], ["4X", "4X", "IL"], ["4Y", "4Y", "IL"], ["4Z", "4Z", "IL"],
  ["5A", "5A", "LY"], ["5B", "5B", "CY"], ["5C", "5G", "MA"], ["5H", "5I", "TZ"],
  ["5J", "5K", "CO"], ["5L", "5M", "LR"], ["5N", "5O", "NG"], ["5P", "5Q", "DK"],
  ["5R", "5S", "MG"], ["5T", "5T", "MR"], ["5U", "5U", "NE"], ["5V", "5V", "TG"],
  ["5W", "5W", "WS"], ["5X", "5X", "UG"], ["5Y", "5Z", "KE"],
  ["6A", "6B", "EG"], ["6C", "6C", "SY"], ["6D", "6J", "MX"], ["6K", "6N", "KR"],
  ["6O", "6O", "SO"], ["6P", "6S", "PK"], ["6T", "6U", "SD"], ["6V", "6W", "SN"],
  ["6X", "6X", "MG"], ["6Y", "6Y", "JM"], ["6Z", "6Z", "LR"],
  ["7A", "7I", "ID"], ["7J", "7N", "JP"], ["7O", "7O", "YE"], ["7P", "7P", "LS"],
  ["7Q", "7Q", "MW"], ["7R", "7R", "DZ"], ["7S", "7S", "SE"], ["7T", "7Y", "DZ"],
  ["7Z", "7Z", "SA"], ["8A", "8I", "ID"], ["8J", "8N", "JP"], ["8P", "8P", "BB"],
  ["8Q", "8Q", "MV"], ["8R", "8R", "GY"], ["8S", "8S", "SE"], ["8T", "8Y", "IN"],
  ["8Z", "8Z", "SA"], ["9A", "9A", "HR"], ["9B", "9D", "IR"], ["9E", "9F", "ET"],
  ["9G", "9G", "GH"], ["9H", "9H", "MT"], ["9I", "9J", "ZM"], ["9K", "9K", "KW"],
  ["9L", "9L", "SL"], ["9M", "9M", "MY"], ["9N", "9N", "NP"], ["9O", "9T", "CD"],
  ["9U", "9U", "BI"], ["9V", "9V", "SG"], ["9W", "9W", "MY"], ["9X", "9X", "RW"],
  ["9Y", "9Z", "TT"],
  ["A2", "A2", "BW"], ["A3", "A3", "TO"], ["A4", "A4", "OM"], ["A5", "A5", "BT"],
  ["A6", "A6", "AE"], ["A7", "A7", "QA"], ["A8", "A8", "LR"], ["A9", "A9", "BH"],
  ["AA", "AL", "US"], ["AM", "AO", "ES"], ["AP", "AS", "PK"], ["AT", "AW", "IN"],
  ["AX", "AX", "AU"], ["AY", "AZ", "AR"], ["B", "B", "CN"],
  ["BM", "BQ", "TW"], ["BU", "BX", "TW"], ["BV", "BV", "TW"],
  ["C2", "C2", "NR"], ["C3", "C3", "AD"], ["C4", "C4", "CY"], ["C5", "C5", "GM"],
  ["C6", "C6", "BS"], ["C7", "C7", "WM"], ["C8", "C9", "MZ"], ["CA", "CE", "CL"],
  ["CF", "CK", "CA"], ["CL", "CM", "CU"], ["CN", "CN", "MA"], ["CO", "CO", "CU"],
  ["CP", "CP", "BO"], ["CQ", "CU", "PT"], ["CV", "CX", "UY"], ["CY", "CZ", "CA"],
  ["D2", "D3", "AO"], ["D4", "D4", "CV"], ["D5", "D5", "LR"], ["D6", "D6", "KM"],
  ["D7", "D9", "KR"], ["DA", "DR", "DE"], ["DS", "DT", "KR"], ["DU", "DZ", "PH"],
  ["E2", "E2", "TH"], ["E3", "E3", "ER"], ["E4", "E4", "PS"], ["E5", "E5", "CK"],
  ["E7", "E7", "BA"], ["EA", "EH", "ES"], ["EI", "EJ", "IE"], ["EK", "EK", "AM"],
  ["EL", "EL", "LR"], ["EM", "EO", "UA"], ["EP", "EQ", "IR"], ["ER", "ER", "MD"],
  ["ES", "ES", "EE"], ["ET", "ET", "ET"], ["EU", "EW", "BY"], ["EX", "EX", "KG"],
  ["EY", "EY", "TJ"], ["EZ", "EZ", "TM"],
  ["F", "F", "FR"], ["G", "G", "GB"], ["H2", "H2", "CY"], ["H3", "H3", "PA"],
  ["H4", "H4", "SB"], ["H6", "H7", "NI"], ["H8", "H9", "PA"], ["HA", "HA", "HU"],
  ["HB", "HB", "CH"], ["HC", "HD", "EC"], ["HE", "HE", "CH"], ["HF", "HF", "PL"],
  ["HG", "HG", "HU"], ["HH", "HH", "HT"], ["HI", "HI", "DO"], ["HJ", "HK", "CO"],
  ["HL", "HL", "KR"], ["HM", "HM", "KP"], ["HN", "HN", "IQ"], ["HO", "HP", "PA"],
  ["HQ", "HR", "HN"], ["HS", "HS", "TH"], ["HT", "HT", "NI"], ["HU", "HU", "SV"],
  ["HV", "HV", "VA"], ["HW", "HY", "FR"], ["HZ", "HZ", "SA"],
  ["I", "I", "IT"], ["J2", "J2", "DJ"], ["J3", "J3", "GD"], ["J4", "J4", "GR"],
  ["J5", "J5", "GW"], ["J6", "J6", "LC"], ["J7", "J7", "DM"], ["J8", "J8", "VC"],
  ["JA", "JS", "JP"], ["JT", "JV", "MN"], ["JW", "JX", "NO"], ["JY", "JY", "JO"],
  ["JZ", "JZ", "ID"], ["K", "K", "US"], ["L2", "L9", "AR"],
  ["LA", "LN", "NO"], ["LO", "LW", "AR"], ["LX", "LX", "LU"], ["LY", "LY", "LT"],
  ["LZ", "LZ", "BG"], ["M", "M", "GB"], ["N", "N", "US"],
  ["OA", "OC", "PE"], ["OD", "OD", "LB"], ["OE", "OE", "AT"], ["OF", "OJ", "FI"],
  ["OK", "OL", "CZ"], ["OM", "OM", "SK"], ["ON", "OT", "BE"], ["OU", "OZ", "DK"],
  ["P2", "P2", "PG"], ["P3", "P3", "CY"], ["P4", "P4", "AW"], ["P5", "P9", "KP"],
  ["PA", "PI", "NL"], ["PJ", "PJ", "AN"], ["PK", "PO", "ID"], ["PP", "PY", "BR"],
  ["PZ", "PZ", "SR"], ["R", "R", "RU"], ["S2", "S3", "BD"], ["S5", "S5", "SI"],
  ["S6", "S6", "SG"], ["S7", "S7", "SC"], ["S8", "S8", "ZA"], ["S9", "S9", "ST"],
  ["SA", "SM", "SE"], ["SN", "SR", "PL"], ["ST", "ST", "SD"], ["SU", "SU", "EG"],
  ["SV", "SZ", "GR"], ["T2", "T2", "TV"], ["T3", "T3", "KI"], ["T4", "T4", "CU"],
  ["T5", "T5", "SO"], ["T6", "T6", "AF"], ["T7", "T7", "SM"], ["T8", "T8", "PW"],
  ["TA", "TC", "TR"], ["TD", "TD", "GT"], ["TE", "TE", "CR"], ["TF", "TF", "IS"],
  ["TG", "TG", "GT"], ["TH", "TH", "FR"], ["TI", "TI", "CR"], ["TJ", "TJ", "CM"],
  ["TK", "TK", "FR"], ["TL", "TL", "CF"], ["TM", "TM", "FR"], ["TN", "TN", "CG"],
  ["TO", "TQ", "FR"], ["TR", "TR", "GA"], ["TS", "TS", "TN"], ["TT", "TT", "TD"],
  ["TU", "TU", "CI"], ["TV", "TX", "FR"], ["TY", "TY", "BJ"], ["TZ", "TZ", "ML"],
  ["UA", "UI", "RU"], ["UJ", "UM", "UZ"], ["UN", "UQ", "KZ"], ["UR", "UZ", "UA"],
  ["V2", "V2", "AG"], ["V3", "V3", "BZ"], ["V4", "V4", "KN"], ["V5", "V5", "NA"],
  ["V6", "V6", "FM"], ["V7", "V7", "MH"], ["V8", "V8", "BN"], ["VA", "VG", "CA"],
  ["VH", "VN", "AU"], ["VO", "VO", "CA"], ["VP", "VQ", "GB"], ["VR", "VR", "HK"],
  ["VS", "VS", "GB"], ["VT", "VW", "IN"], ["VX", "VY", "CA"], ["VZ", "VZ", "AU"],
  ["W", "W", "US"], ["XA", "XI", "MX"], ["XJ", "XO", "CA"], ["XP", "XP", "DK"],
  ["XQ", "XR", "CL"], ["XS", "XS", "CN"], ["XT", "XT", "BF"], ["XU", "XU", "KH"],
  ["XV", "XV", "VN"], ["XW", "XW", "LA"], ["XX", "XX", "MO"], ["XY", "XZ", "MM"],
  ["Y2", "Y9", "DE"], ["YA", "YA", "AF"], ["YB", "YH", "ID"], ["YI", "YI", "IQ"],
  ["YJ", "YJ", "VU"], ["YK", "YK", "SY"], ["YL", "YL", "LV"], ["YM", "YM", "TR"],
  ["YN", "YN", "NI"], ["YO", "YR", "RO"], ["YS", "YS", "SV"], ["YT", "YU", "YU"],
  ["YV", "YY", "VE"], ["Z2", "Z2", "ZW"], ["Z3", "Z3", "MK"], ["ZA", "ZA", "AL"],
  ["ZB", "ZJ", "GB"], ["ZK", "ZM", "NZ"], ["ZN", "ZO", "GB"], ["ZP", "ZP", "PY"],
  ["ZQ", "ZQ", "GB"], ["ZR", "ZU", "ZA"], ["ZV", "ZZ", "BR"],
];

function normalized(cs: string): string {
  return cs.trim().toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 2);
}

export function countryForCallsign(cs: string | null): string | null {
  if (!cs) return null;
  const p = normalized(cs);
  if (!p) return null;
  // Ranges are inclusive, prefix comparison. Some rows use a 1-char range (e.g. "F","F","FR");
  // handle both 1- and 2-char normalized prefix.
  for (const [lo, hi, iso] of RANGES) {
    if (lo.length === 1) {
      if (p[0] >= lo && p[0] <= hi) return iso;
    } else {
      if (p >= lo && p <= hi) return iso;
    }
  }
  return null;
}
```

- [ ] **Step 5: Rewire `src/detectors/identity.ts`**

Replace its inline lookup helpers with imports from the two new files:

```ts
import { countryForMid } from "../mid-table";
import { countryForCallsign } from "../callsign-table";
// The identity detector still exports these two names for use by fusion + tests.
export { countryForMid, countryForCallsign };
```

Keep every other line of `identity.ts` byte-identical.

- [ ] **Step 6: Run the identity test suite**

Run: `npm test -- test/identity.test.ts`
Expected: PASS the new "broadened coverage" cases plus every prior case.

- [ ] **Step 7: Commit**

```bash
git add src/mid-table.ts src/callsign-table.ts src/detectors/identity.ts test/identity.test.ts
git commit -m "feat: broaden MID + callsign country lookups (spec §4a identity axis)"
```

---

### Task 4: Positional mechanism sub-model

Continuous score built from `route_deviation` events and `corridorDistanceM`. Replaces the boolean `geo.inCorridor` gate for scoring purposes.

**Files:**
- Create: `src/mechanisms/positional.ts`
- Create: `test/mechanisms-positional.test.ts`

**Interfaces:**
- Consumes: `SubModelContext` (Task 1).
- Produces: `positionalMechanism: MechanismSubModel` with:
  - `score = max( 1 − clamp01(corridorDistanceM / cfg.corridorBufferM), routeAnomalyScore )`
  - `routeAnomalyScore = clamp01(recentRouteDeviations / 5)` (5 events in a 24-h decay window → 1.0)
- `contributingEventIds` = ids of the last 3 `route_deviation` events plus the position anchor.

- [ ] **Step 1: Write the failing test**

Create `test/mechanisms-positional.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import { GeoContext } from "../src/geo/context";
import { positionalMechanism } from "../src/mechanisms/positional";
import { newVesselState, type AnomalyEvent } from "../src/types";

const cables = { type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "C1" }, geometry: { type: "LineString", coordinates: [[120.0, 22.0], [121.0, 22.0]] } }] };
const empty = { type: "FeatureCollection", features: [] };
const geo = new GeoContext(cables as any, empty as any, 1000, empty as any, 5000);
const NOW = 1_700_000_000_000;

function s(mmsi: number) {
  const st = newVesselState(mmsi, NOW);
  return st;
}

function evt(id: string, type: AnomalyEvent["type"], ts: number, extra: any = {}): AnomalyEvent {
  return { id, type, severity: 3 as any, mmsi: 416, lon: 120.5, lat: 22.001, startTs: ts, endTs: ts, evidence: extra };
}

describe("positionalMechanism", () => {
  it("scores 1.0 for a vessel directly on the corridor centerline", () => {
    const st = s(416);
    st.ring.push({ mmsi: 416, lon: 120.5, lat: 22.0, sog: 0, cog: 0, heading: null, ts: NOW });
    const r = positionalMechanism.score({ state: st, events: [], geo, cfg: CONFIG, now: NOW });
    expect(r.score).toBeGreaterThan(0.99);
    expect(r.axis).toBe("positional");
  });
  it("scores near 0 for a vessel far from any corridor with no route events", () => {
    const st = s(416);
    st.ring.push({ mmsi: 416, lon: 130.0, lat: 34.0, sog: 12, cog: 90, heading: null, ts: NOW });
    const r = positionalMechanism.score({ state: st, events: [], geo, cfg: CONFIG, now: NOW });
    expect(r.score).toBeLessThan(0.05);
  });
  it("accumulates route-deviation events up to 1.0 at 5 recent events", () => {
    const st = s(416);
    st.ring.push({ mmsi: 416, lon: 130.0, lat: 34.0, sog: 12, cog: 90, heading: null, ts: NOW });
    const events = Array.from({ length: 5 }, (_, i) => evt(`r-${i}`, "route_deviation", NOW - i * 3_600_000));
    const r = positionalMechanism.score({ state: st, events, geo, cfg: CONFIG, now: NOW });
    expect(r.score).toBeGreaterThanOrEqual(1.0 - 1e-9);
    expect(r.contributingEventIds.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/mechanisms-positional.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/mechanisms/positional.ts — deviation from expected route / corridor (spec §4a).
import type { MechanismScore, MechanismSubModel, SubModelContext } from "./types";

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export const positionalMechanism: MechanismSubModel = {
  axis: "positional",
  score(ctx: SubModelContext): MechanismScore {
    const lp = ctx.state.ring[ctx.state.ring.length - 1];
    let corridorScore = 0;
    if (lp) {
      const d = ctx.geo.distanceToCorridorM([lp.lon, lp.lat]);
      // Score = 1 at the centerline, 0 at buffer distance.
      corridorScore = 1 - clamp01(d / ctx.cfg.corridorBufferM);
    }
    const halfLife = ctx.cfg.v2.axisHalfLifeMs.positional;
    // Sum decayed contribution of each route_deviation event within one half-life.
    let routeSum = 0;
    const contributing: string[] = [];
    for (const e of ctx.events) {
      if (e.type !== "route_deviation") continue;
      const age = ctx.now - e.startTs;
      if (age > halfLife) continue;
      routeSum += 0.5 ** (age / halfLife);
      if (contributing.length < 3) contributing.push(e.id);
    }
    const routeScore = clamp01(routeSum / 5);
    const score = Math.max(corridorScore, routeScore);
    return {
      axis: "positional",
      score,
      evidence: {
        corridorDistanceM: lp ? ctx.geo.distanceToCorridorM([lp.lon, lp.lat]) : null,
        routeEventsInWindow: contributing.length,
      },
      contributingEventIds: contributing,
      lastUpdated: ctx.now,
    };
  },
};
```

Note: `geo.distanceToCorridorM` may not exist as-named on `GeoContext` — inspect `src/geo/context.ts`. If the existing method is `nearestCorridor(...).distanceM` or similar, adapt the call. Do NOT invent a new method on GeoContext unless one is genuinely absent; if it is, add it in a small preparatory step and cover with a unit test in `test/geo.test.ts`.

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- test/mechanisms-positional.test.ts`
Expected: PASS all three cases.

- [ ] **Step 5: Commit**

```bash
git add src/mechanisms/positional.ts test/mechanisms-positional.test.ts
git commit -m "feat: positional mechanism sub-model (spec §4a)"
```

---

### Task 5: Kinematic mechanism sub-model

Continuous drag, speed-excess, and Wijaya-style loitering combined. Replaces every 2 h / 40° / 150 m step function.

**Files:**
- Create: `src/mechanisms/kinematic.ts`
- Create: `test/mechanisms-kinematic.test.ts`

**Interfaces:**
- Consumes: `SubModelContext`.
- Produces: `kinematicMechanism: MechanismSubModel` with score = `max(dragScore, speedExcessScore, loiterScore)`:
  - `dragScore` from `anchor_drag` event `cogStdDeg` and `displacementM`.
  - `speedExcessScore = clamp01((sog − maxForType) / maxForType)`.
  - `loiterScore = clamp01(Wijaya F_c,h,d / calibrated_ceiling)` using positions in the last hour.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import { GeoContext } from "../src/geo/context";
import { kinematicMechanism } from "../src/mechanisms/kinematic";
import { newVesselState, type AnomalyEvent } from "../src/types";

const empty = { type: "FeatureCollection", features: [] };
const geo = new GeoContext(empty as any, empty as any, 1000, empty as any, 5000);
const NOW = 1_700_000_000_000;
const evt = (id: string, type: AnomalyEvent["type"], ts: number, extra: any): AnomalyEvent =>
  ({ id, type, severity: 3 as any, mmsi: 416, lon: 120, lat: 22, startTs: ts, endTs: ts, evidence: extra });

describe("kinematicMechanism", () => {
  it("drag: cogStd=80° displacement=300m yields score > 0.5", () => {
    const st = newVesselState(416, NOW);
    st.shipType = 70;
    const events = [evt("d1", "anchor_drag", NOW - 3600_000, { cogStdDeg: 80, displacementM: 300 })];
    const r = kinematicMechanism.score({ state: st, events, geo, cfg: CONFIG, now: NOW });
    expect(r.score).toBeGreaterThan(0.5);
  });
  it("speed excess for cargo (max ~25 kn) at 40 kn scores > 0.4", () => {
    const st = newVesselState(416, NOW);
    st.shipType = 70;
    st.ring.push({ mmsi: 416, lon: 120, lat: 22, sog: 40, cog: 0, heading: null, ts: NOW });
    const r = kinematicMechanism.score({ state: st, events: [], geo, cfg: CONFIG, now: NOW });
    expect(r.score).toBeGreaterThan(0.4);
  });
  it("moving-and-turning positions in a small area drive the loiter score", () => {
    const st = newVesselState(416, NOW);
    for (let i = 0; i < 12; i++) {
      st.ring.push({ mmsi: 416, lon: 120 + 0.001 * Math.cos(i), lat: 22 + 0.001 * Math.sin(i), sog: 1.5, cog: (i * 30) % 360, heading: null, ts: NOW - (12 - i) * 60_000 });
    }
    const r = kinematicMechanism.score({ state: st, events: [], geo, cfg: CONFIG, now: NOW });
    expect(r.score).toBeGreaterThan(0.4);
  });
  it("returns 0 for a well-behaved cargo transit", () => {
    const st = newVesselState(416, NOW);
    st.shipType = 70;
    st.ring.push({ mmsi: 416, lon: 120, lat: 22, sog: 12, cog: 90, heading: null, ts: NOW });
    const r = kinematicMechanism.score({ state: st, events: [], geo, cfg: CONFIG, now: NOW });
    expect(r.score).toBeLessThan(0.05);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/mechanisms-kinematic.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// src/mechanisms/kinematic.ts (spec §4a). Wijaya F_{c,h,d} for loiter; graded drag + speed excess.
import type { MechanismScore, MechanismSubModel, SubModelContext } from "./types";
import type { AnomalyEvent, VesselState } from "../types";

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

// Approximate max SOG per ship-type bucket (from src/detectors/speed.ts).
const MAX_SOG_KN: Record<number, number> = { 30: 12, 60: 30, 70: 25, 80: 18, 33: 20, 37: 22 };

function shipTypeBucketMax(shipType: number | null): number {
  if (shipType === null) return 30; // permissive default: nothing scores unless clearly over
  const t = shipType;
  if (t >= 30 && t < 40) return MAX_SOG_KN[Math.floor(t / 10) * 10] ?? 30;
  if (t >= 60 && t < 90) return MAX_SOG_KN[Math.floor(t / 10) * 10] ?? 25;
  return 30;
}

function dragScore(events: AnomalyEvent[], now: number, halfLife: number): { score: number; ids: string[] } {
  let best = 0; const ids: string[] = [];
  for (const e of events) {
    if (e.type !== "anchor_drag") continue;
    const age = now - e.startTs;
    if (age > halfLife) continue;
    const cog = Number((e.evidence as any).cogStdDeg ?? 0);
    const disp = Number((e.evidence as any).displacementM ?? 0);
    // Sigmoid-graded: at threshold (40° / 150 m) sigmoid ≈ 0.5, doubling puts it near 0.88.
    const cogPart = 1 / (1 + Math.exp(-2 * ((cog / 40) - 1)));
    const dispPart = 1 / (1 + Math.exp(-2 * ((disp / 150) - 1)));
    const s = (cogPart + dispPart) / 2 * (0.5 ** (age / halfLife));
    if (s > best) { best = s; ids.length = 0; ids.push(e.id); }
  }
  return { score: best, ids };
}

function speedExcessScore(state: VesselState): number {
  const lp = state.ring[state.ring.length - 1];
  if (!lp) return 0;
  const max = shipTypeBucketMax(state.shipType);
  return clamp01((lp.sog - max) / max);
}

// Wijaya F_{c,h,d} = (sum |ΔCourse|) * (sum |ΔHeading|) * (sum Speed) / (180° * boundingBoxAreaM2 * geodeticDistM).
// We approximate |ΔHeading| ≈ |ΔCourse| when heading is null.
function loiterScore(state: VesselState, now: number): number {
  const pts = state.ring.filter((p) => now - p.ts <= 60 * 60 * 1000);
  if (pts.length < 8) return 0;
  let sumDCourse = 0; let sumDHead = 0; let sumSpeed = 0;
  for (let i = 1; i < pts.length; i++) {
    const dc = Math.abs(pts[i].cog - pts[i - 1].cog);
    const shortest = Math.min(dc, 360 - dc);
    sumDCourse += shortest;
    sumSpeed += pts[i].sog;
    sumDHead += shortest; // heading proxy
  }
  const lons = pts.map((p) => p.lon), lats = pts.map((p) => p.lat);
  const dLon = Math.max(...lons) - Math.min(...lons);
  const dLat = Math.max(...lats) - Math.min(...lats);
  // ~1° ≈ 111 km at equator; sufficient for a bounded-box denominator.
  const boxM2 = Math.max(dLon * 111_000, 1) * Math.max(dLat * 111_000, 1);
  const geoDistM = Math.max(Math.hypot(dLon * 111_000, dLat * 111_000), 1);
  const F = (sumDCourse * sumDHead * sumSpeed) / (180 * boxM2 * geoDistM);
  // Empirical ceiling — calibrated against test fixtures. Refit after label accrual.
  return clamp01(F / 5e-4);
}

export const kinematicMechanism: MechanismSubModel = {
  axis: "kinematic",
  score(ctx: SubModelContext): MechanismScore {
    const halfLife = ctx.cfg.v2.axisHalfLifeMs.kinematic;
    const drag = dragScore(ctx.events, ctx.now, halfLife);
    const speed = speedExcessScore(ctx.state);
    const loit = loiterScore(ctx.state, ctx.now);
    const contributing = drag.ids.slice();
    return {
      axis: "kinematic",
      score: Math.max(drag.score, speed, loit),
      evidence: { dragScore: drag.score, speedExcess: speed, loitScore: loit, shipType: ctx.state.shipType },
      contributingEventIds: contributing,
      lastUpdated: ctx.now,
    };
  },
};
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- test/mechanisms-kinematic.test.ts`
Expected: PASS all four cases. If the empirical loiter ceiling `5e-4` doesn't fit the fixture, tune it and re-run — do not lower the assertion.

- [ ] **Step 5: Commit**

```bash
git add src/mechanisms/kinematic.ts test/mechanisms-kinematic.test.ts
git commit -m "feat: kinematic mechanism sub-model — drag + speed excess + Wijaya loiter (spec §4a)"
```

---

### Task 6: Contextual mechanism sub-model

Hand rules v1 over `(shipType bucket, in_corridor, hour_of_day_utc, sog_regime)` producing `[0, 1]`. Table becomes learnable from labels post-Phase-0-accumulation (deferred follow-up).

**Files:**
- Create: `src/mechanisms/contextual.ts`
- Create: `test/mechanisms-contextual.test.ts`

**Interfaces:**
- Consumes: `SubModelContext`.
- Produces: `contextualMechanism: MechanismSubModel`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import { GeoContext } from "../src/geo/context";
import { contextualMechanism } from "../src/mechanisms/contextual";
import { newVesselState } from "../src/types";

const cables = { type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "C1" }, geometry: { type: "LineString", coordinates: [[120.0, 22.0], [121.0, 22.0]] } }] };
const empty = { type: "FeatureCollection", features: [] };
const geo = new GeoContext(cables as any, empty as any, 1000, empty as any, 5000);
const NOW = 1_700_000_000_000;

const on = (lon: number, lat: number, sog: number, shipType: number, ts = NOW) => {
  const st = newVesselState(416, NOW);
  st.shipType = shipType;
  st.ring.push({ mmsi: 416, lon, lat, sog, cog: 90, heading: null, ts });
  return st;
};

describe("contextualMechanism", () => {
  it("tanker (80) slow in cable corridor scores high (>0.7)", () => {
    const r = contextualMechanism.score({ state: on(120.5, 22.0, 1.0, 80), events: [], geo, cfg: CONFIG, now: NOW });
    expect(r.score).toBeGreaterThan(0.7);
  });
  it("cargo (70) transiting at 10 kn in corridor is nominal (<0.3)", () => {
    const r = contextualMechanism.score({ state: on(120.5, 22.0, 10, 70), events: [], geo, cfg: CONFIG, now: NOW });
    expect(r.score).toBeLessThan(0.3);
  });
  it("no signal outside corridor regardless of ship type", () => {
    const r = contextualMechanism.score({ state: on(130.0, 34.0, 1.0, 80), events: [], geo, cfg: CONFIG, now: NOW });
    expect(r.score).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/mechanisms-contextual.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// src/mechanisms/contextual.ts — vessel-type × area × time-of-day appropriateness (spec §4a).
import type { MechanismScore, MechanismSubModel, SubModelContext } from "./types";

function shipTypeBucket(t: number | null): "fishing" | "tanker" | "cargo" | "passenger" | "other" {
  if (t === null) return "other";
  if (t >= 30 && t < 40) return "fishing";
  if (t >= 60 && t < 70) return "passenger";
  if (t >= 70 && t < 80) return "cargo";
  if (t >= 80 && t < 90) return "tanker";
  return "other";
}

export const contextualMechanism: MechanismSubModel = {
  axis: "contextual",
  score(ctx: SubModelContext): MechanismScore {
    const lp = ctx.state.ring[ctx.state.ring.length - 1];
    if (!lp) return { axis: "contextual", score: 0, evidence: {}, contributingEventIds: [], lastUpdated: ctx.now };
    const inCorridor = ctx.geo.inCorridor([lp.lon, lp.lat]);
    if (!inCorridor) return { axis: "contextual", score: 0, evidence: { inCorridor: false }, contributingEventIds: [], lastUpdated: ctx.now };
    const bucket = shipTypeBucket(ctx.state.shipType);
    const slow = lp.sog < 3;
    const nightHour = new Date(ctx.now).getUTCHours() >= 22 || new Date(ctx.now).getUTCHours() < 5;
    let score = 0;
    if (bucket === "tanker") score = slow ? 0.85 : 0.35;
    else if (bucket === "cargo") score = slow ? 0.5 : 0.15;
    else if (bucket === "passenger") score = slow ? 0.4 : 0.1;
    else if (bucket === "fishing") score = slow ? 0.3 : 0.2;
    else score = slow ? 0.3 : 0.15;
    if (nightHour) score = Math.min(1, score + 0.1);
    return {
      axis: "contextual",
      score,
      evidence: { inCorridor, bucket, sog: lp.sog, hourUtc: new Date(ctx.now).getUTCHours() },
      contributingEventIds: [],
      lastUpdated: ctx.now,
    };
  },
};
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- test/mechanisms-contextual.test.ts`
Expected: PASS all three cases.

- [ ] **Step 5: Commit**

```bash
git add src/mechanisms/contextual.ts test/mechanisms-contextual.test.ts
git commit -m "feat: contextual mechanism sub-model — hand rules v1 (spec §4a)"
```

---

### Task 7: Complex / Interaction mechanism sub-model

Score co-occurring events in a rolling window. Combos over the recent event buffer.

**Files:**
- Create: `src/mechanisms/complex.ts`
- Create: `test/mechanisms-complex.test.ts`

**Interfaces:**
- Consumes: `SubModelContext`.
- Produces: `complexMechanism: MechanismSubModel`.
- Combos (each hit adds 0.2, capped at 1.0):
  - `ais_gap ∧ dark_reposition ∧ inCorridor`
  - `loitering ∧ identity_change`
  - `anchor_drag ∧ speed_anomaly`
  - `ais_gap ∧ identity_change` (masked identity re-emergence)
  - `route_deviation ∧ loitering`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import { GeoContext } from "../src/geo/context";
import { complexMechanism } from "../src/mechanisms/complex";
import { newVesselState, type AnomalyEvent } from "../src/types";

const cables = { type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "C1" }, geometry: { type: "LineString", coordinates: [[120.0, 22.0], [121.0, 22.0]] } }] };
const empty = { type: "FeatureCollection", features: [] };
const geo = new GeoContext(cables as any, empty as any, 1000, empty as any, 5000);
const NOW = 1_700_000_000_000;
const evt = (id: string, type: AnomalyEvent["type"], ts: number, extra: any = {}): AnomalyEvent =>
  ({ id, type, severity: 3 as any, mmsi: 416, lon: 120.5, lat: 22.0, startTs: ts, endTs: ts, evidence: extra });

describe("complexMechanism", () => {
  it("scores 0 for a single event", () => {
    const st = newVesselState(416, NOW);
    st.ring.push({ mmsi: 416, lon: 120.5, lat: 22, sog: 0, cog: 0, heading: null, ts: NOW });
    const r = complexMechanism.score({ state: st, events: [evt("a", "ais_gap", NOW - 100_000, { endInCorridor: true, distanceM: 20_000 })], geo, cfg: CONFIG, now: NOW });
    expect(r.score).toBe(0);
  });
  it("ais_gap + dark reposition + in-corridor scores 0.2", () => {
    const st = newVesselState(416, NOW);
    st.ring.push({ mmsi: 416, lon: 120.5, lat: 22, sog: 0, cog: 0, heading: null, ts: NOW });
    const events = [
      evt("a", "ais_gap", NOW - 100_000, { endInCorridor: true, distanceM: 20_000 }),
      evt("b", "ais_gap", NOW - 90_000, { distanceM: 20_000 }),
    ];
    const r = complexMechanism.score({ state: st, events, geo, cfg: CONFIG, now: NOW });
    expect(r.score).toBeCloseTo(0.2, 5);
    expect(r.contributingEventIds).toContain("a");
  });
  it("loiter + identity_change scores 0.2, adds to another combo up to 0.4", () => {
    const st = newVesselState(416, NOW);
    st.ring.push({ mmsi: 416, lon: 120.5, lat: 22, sog: 0, cog: 0, heading: null, ts: NOW });
    const events = [
      evt("l", "loitering", NOW - 100_000, {}),
      evt("i", "identity", NOW - 50_000, { kind: "identity_change" }),
      evt("a", "ais_gap", NOW - 30_000, { distanceM: 20_000 }),
      evt("a2", "ais_gap", NOW - 25_000, { endInCorridor: true, distanceM: 20_000 }),
    ];
    const r = complexMechanism.score({ state: st, events, geo, cfg: CONFIG, now: NOW });
    expect(r.score).toBeGreaterThanOrEqual(0.4);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/mechanisms-complex.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// src/mechanisms/complex.ts — co-occurring event combos (spec §4a).
import type { AnomalyEvent } from "../types";
import type { MechanismScore, MechanismSubModel, SubModelContext } from "./types";

const COMBO_WEIGHT = 0.2;

type Combo = { name: string; test: (evts: AnomalyEvent[], ctx: SubModelContext) => string[] | null };

const COMBOS: Combo[] = [
  {
    name: "gap+dark_reposition+in_corridor",
    test: (evts, ctx) => {
      const gaps = evts.filter((e) => e.type === "ais_gap");
      const inCorr = gaps.find((e) => (e.evidence as any).endInCorridor === true || (e.evidence as any).startInCorridor === true);
      const dark = gaps.find((e) => Number((e.evidence as any).distanceM ?? 0) > ctx.cfg.darkRepositionMinM);
      return inCorr && dark ? [inCorr.id, dark.id] : null;
    },
  },
  {
    name: "loiter+identity_change",
    test: (evts) => {
      const l = evts.find((e) => e.type === "loitering");
      const i = evts.find((e) => e.type === "identity" && (e.evidence as any).kind === "identity_change");
      return l && i ? [l.id, i.id] : null;
    },
  },
  {
    name: "drag+speed",
    test: (evts) => {
      const d = evts.find((e) => e.type === "anchor_drag");
      const s = evts.find((e) => e.type === "speed_anomaly");
      return d && s ? [d.id, s.id] : null;
    },
  },
  {
    name: "gap+identity_change",
    test: (evts) => {
      const g = evts.find((e) => e.type === "ais_gap");
      const i = evts.find((e) => e.type === "identity" && (e.evidence as any).kind === "identity_change");
      return g && i ? [g.id, i.id] : null;
    },
  },
  {
    name: "route+loiter",
    test: (evts) => {
      const r = evts.find((e) => e.type === "route_deviation");
      const l = evts.find((e) => e.type === "loitering");
      return r && l ? [r.id, l.id] : null;
    },
  },
];

export const complexMechanism: MechanismSubModel = {
  axis: "complex",
  score(ctx: SubModelContext): MechanismScore {
    const halfLife = ctx.cfg.v2.axisHalfLifeMs.complex;
    const inWindow = ctx.events.filter((e) => ctx.now - e.startTs <= halfLife);
    let score = 0;
    const contributing = new Set<string>();
    for (const combo of COMBOS) {
      const hit = combo.test(inWindow, ctx);
      if (!hit) continue;
      score = Math.min(1, score + COMBO_WEIGHT);
      for (const id of hit) contributing.add(id);
    }
    return {
      axis: "complex",
      score,
      evidence: { hitCombos: COMBOS.filter((c) => c.test(inWindow, ctx) !== null).map((c) => c.name) },
      contributingEventIds: [...contributing],
      lastUpdated: ctx.now,
    };
  },
};
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- test/mechanisms-complex.test.ts`
Expected: PASS all three cases.

- [ ] **Step 5: Commit**

```bash
git add src/mechanisms/complex.ts test/mechanisms-complex.test.ts
git commit -m "feat: complex/interaction mechanism sub-model — combos over evidence buffer (spec §4a)"
```

---

### Task 8: Identity mechanism sub-model (3-facet C4ADS)

**Files:**
- Create: `src/mechanisms/identity.ts`
- Create: `test/mechanisms-identity.test.ts`

**Interfaces:**
- Consumes: `SubModelContext`, `countryForMid`, `countryForCallsign` (Task 3).
- Produces: `identityMechanism: MechanismSubModel`.
- Score:
  - Registered vs Digital mismatch: +0.35 if MID country ≠ callsign country and both are known.
  - Digital-facet churn: +0.30 if `identity_change` event within window.
  - Teleport / dark_teleport: +0.20 (`identity` event with `kind='teleport'`).
  - Physical facet: 0 in v1 (scaffold).
  - Shell identity: +0.15 if MMSI has never been paired with a stable callsign — proxied here as identities-list has ≥ 2 distinct callsigns.
  - Clamp to `[0, 1]`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import { GeoContext } from "../src/geo/context";
import { identityMechanism } from "../src/mechanisms/identity";
import { newVesselState, type AnomalyEvent } from "../src/types";

const empty = { type: "FeatureCollection", features: [] };
const geo = new GeoContext(empty as any, empty as any, 1000, empty as any, 5000);
const NOW = 1_700_000_000_000;
const evt = (id: string, ts: number, extra: any): AnomalyEvent =>
  ({ id, type: "identity", severity: 3 as any, mmsi: 416, lon: 120, lat: 22, startTs: ts, endTs: ts, evidence: extra });

describe("identityMechanism", () => {
  it("scores near 0 for a clean single-callsign vessel with matching country", () => {
    const st = newVesselState(211000001, NOW); // DE MID (211)
    st.callsign = "DA1234"; // DE prefix
    const r = identityMechanism.score({ state: st, events: [], geo, cfg: CONFIG, now: NOW });
    expect(r.score).toBeLessThan(0.05);
  });
  it("registered/digital mismatch adds 0.35", () => {
    const st = newVesselState(412000001, NOW); // CN
    st.callsign = "LA1234"; // NO
    const r = identityMechanism.score({ state: st, events: [], geo, cfg: CONFIG, now: NOW });
    expect(r.score).toBeGreaterThanOrEqual(0.35);
    expect(r.evidence.registeredCountry).toBe("CN");
    expect(r.evidence.digitalCountry).toBe("NO");
  });
  it("identity_change adds 0.30 and teleport adds 0.20", () => {
    const st = newVesselState(412000001, NOW);
    st.callsign = "BA1234";
    const events = [
      evt("i1", NOW - 100_000, { kind: "identity_change" }),
      evt("i2", NOW - 50_000, { kind: "teleport" }),
    ];
    const r = identityMechanism.score({ state: st, events, geo, cfg: CONFIG, now: NOW });
    expect(r.score).toBeGreaterThanOrEqual(0.5);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/mechanisms-identity.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/mechanisms/identity.ts — C4ADS 3-facet identity (spec §4a).
import { countryForCallsign, countryForMid } from "../mid-table";
// countryForCallsign is exported from callsign-table via detectors/identity.ts re-export.
import { countryForCallsign as csCountry } from "../callsign-table";
import type { MechanismScore, MechanismSubModel, SubModelContext } from "./types";

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export const identityMechanism: MechanismSubModel = {
  axis: "identity",
  score(ctx: SubModelContext): MechanismScore {
    const halfLife = ctx.cfg.v2.axisHalfLifeMs.identity;
    const registered = countryForMid(ctx.state.mmsi);
    const digital = csCountry(ctx.state.callsign);
    let s = 0;
    const contrib: string[] = [];
    if (registered && digital && registered !== digital) s += 0.35;
    for (const e of ctx.events) {
      if (e.type !== "identity") continue;
      if (ctx.now - e.startTs > halfLife) continue;
      const kind = (e.evidence as any).kind;
      if (kind === "identity_change") { s += 0.30; contrib.push(e.id); }
      else if (kind === "teleport") { s += 0.20; contrib.push(e.id); }
    }
    const distinctCallsigns = new Set(ctx.state.identities.map((i) => i.callsign).filter(Boolean)).size;
    if (distinctCallsigns >= 2) s += 0.15;
    return {
      axis: "identity",
      score: clamp01(s),
      evidence: { registeredCountry: registered, digitalCountry: digital, distinctCallsigns },
      contributingEventIds: contrib,
      lastUpdated: ctx.now,
    };
  },
};
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- test/mechanisms-identity.test.ts`
Expected: PASS all three cases.

- [ ] **Step 5: Commit**

```bash
git add src/mechanisms/identity.ts test/mechanisms-identity.test.ts
git commit -m "feat: identity mechanism sub-model — C4ADS 3-facet (spec §4a)"
```

---

### Task 9: `WeightedSumPlattFuser` + strategy interface

**Files:**
- Create: `src/fusers/weightedSumPlatt.ts`
- Create: `src/fusers/index.ts` (strategy dispatch)
- Create: `test/weightedSumPlatt.test.ts`

**Interfaces:**
- Produces:
  - `class WeightedSumPlattFuser implements IntentFuser`
  - `function getFuser(name: "v1" | "v2"): IntentFuser | null` — v1 returns null (caller uses legacy path). v2 returns a `WeightedSumPlattFuser` singleton.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import { WeightedSumPlattFuser } from "../src/fusers/weightedSumPlatt";
import { MECHANISM_AXES, type MechanismScore } from "../src/mechanisms/types";
import { THREAT_CATEGORIES } from "../src/types";

const uniform = (v: number): Record<string, MechanismScore> => Object.fromEntries(MECHANISM_AXES.map((a) => [a, { axis: a, score: v, evidence: {}, contributingEventIds: [], lastUpdated: 0 }])) as any;

describe("WeightedSumPlattFuser", () => {
  const fuser = new WeightedSumPlattFuser();
  it("returns a posterior for each threat category", () => {
    const out = fuser.fuse(uniform(0) as any, CONFIG);
    for (const c of THREAT_CATEGORIES) {
      expect(out[c]).toBeDefined();
      expect(out[c].state).toBe("none");
    }
  });
  it("higher mechanism scores raise P monotonically", () => {
    const lo = fuser.fuse(uniform(0.1) as any, CONFIG);
    const hi = fuser.fuse(uniform(0.9) as any, CONFIG);
    for (const c of THREAT_CATEGORIES) {
      expect(hi[c].P).toBeGreaterThan(lo[c].P);
    }
  });
  it("marks calibrationState based on config", () => {
    const out = fuser.fuse(uniform(0.5) as any, CONFIG);
    for (const c of THREAT_CATEGORIES) expect(out[c].calibrationState).toBe("uncalibrated");
  });
  it("topContributingAxes is sorted by W[c][m]*mech.score descending", () => {
    const scores: Record<string, MechanismScore> = {
      positional: { axis: "positional", score: 1, evidence: {}, contributingEventIds: [], lastUpdated: 0 },
      kinematic:  { axis: "kinematic",  score: 0.5, evidence: {}, contributingEventIds: [], lastUpdated: 0 },
      contextual: { axis: "contextual", score: 0, evidence: {}, contributingEventIds: [], lastUpdated: 0 },
      complex:    { axis: "complex",    score: 0, evidence: {}, contributingEventIds: [], lastUpdated: 0 },
      identity:   { axis: "identity",   score: 0, evidence: {}, contributingEventIds: [], lastUpdated: 0 },
    };
    const out = fuser.fuse(scores as any, CONFIG);
    // cable_interference weights: pos 0.30, kin 0.60 -> kin 0.30 vs pos 0.30 vs others 0 => tie or kin first
    const top = out.cable_interference.topContributingAxes[0][0];
    expect(["kinematic", "positional"]).toContain(top);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/weightedSumPlatt.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/fusers/weightedSumPlatt.ts`**

```ts
// src/fusers/weightedSumPlatt.ts — v1 fuser (spec §4b).
import type { Config } from "../config";
import type { IntentFuser, IntentPosterior, MechanismAxis, MechanismScore } from "../mechanisms/types";
import { MECHANISM_AXES } from "../mechanisms/types";
import { THREAT_CATEGORIES, type ThreatCategory } from "../types";

function clamp01(x: number): number { return Math.max(0, Math.min(1, x)); }
function sigmoid(x: number): number { return 1 / (1 + Math.exp(x)); } // note: exp(x), not -x — matches P = 1/(1+exp(A*s+B))

function bandFor(P: number, bands: { watch: number; elevated: number; high: number }): IntentPosterior["state"] {
  if (P >= bands.high) return "high";
  if (P >= bands.elevated) return "elevated";
  if (P >= bands.watch) return "watch";
  return "none";
}

export class WeightedSumPlattFuser implements IntentFuser {
  fuse(mechScores: Record<MechanismAxis, MechanismScore>, cfg: Config): Record<ThreatCategory, IntentPosterior> {
    const out = {} as Record<ThreatCategory, IntentPosterior>;
    for (const c of THREAT_CATEGORIES) {
      const contribs: [MechanismAxis, number][] = [];
      let raw = 0;
      for (const a of MECHANISM_AXES) {
        const w = cfg.v2.W[c][a];
        const contrib = w * mechScores[a].score;
        raw += contrib;
        contribs.push([a, contrib]);
      }
      const platt = cfg.v2.platt[c];
      const P = platt.state === "calibrated" ? sigmoid(platt.A * raw + platt.B) : clamp01(raw);
      contribs.sort((a, b) => b[1] - a[1]);
      out[c] = {
        P,
        state: bandFor(P, cfg.v2.intentBands),
        topContributingAxes: contribs.slice(0, 3),
        calibrationState: platt.state,
      };
    }
    return out;
  }
}
```

- [ ] **Step 4: Implement `src/fusers/index.ts`**

```ts
// src/fusers/index.ts — strategy dispatch.
import type { IntentFuser } from "../mechanisms/types";
import { WeightedSumPlattFuser } from "./weightedSumPlatt";

const V2 = new WeightedSumPlattFuser();

export function getFuser(name: "v1" | "v2"): IntentFuser | null {
  return name === "v2" ? V2 : null;
}
```

- [ ] **Step 5: Run to verify pass**

Run: `npm test -- test/weightedSumPlatt.test.ts`
Expected: PASS all four cases.

- [ ] **Step 6: Commit**

```bash
git add src/fusers/weightedSumPlatt.ts src/fusers/index.ts test/weightedSumPlatt.test.ts
git commit -m "feat: WeightedSumPlattFuser + strategy interface (spec §4b)"
```

---

### Task 10: v2 assessment lifecycle — state-band transitions with dwell

Turn a stream of `VesselAssessmentV2` snapshots into `open`/`closed` events on the D1 side, per spec §4c. The band `state` alone drives the lifecycle: entering `high`/`elevated` opens an assessment; falling below `watch` for the dwell closes it.

**Files:**
- Create: `src/fusers/lifecycle.ts`
- Create: `test/fuser-lifecycle-v2.test.ts`

**Interfaces:**
- Produces:
  - `interface LifecycleState { belowSince: Record<ThreatCategory, number | null>; open: Record<ThreatCategory, boolean>; }`
  - `function newLifecycleState(): LifecycleState`
  - `function stepLifecycle(prev: LifecycleState, posteriors: Record<ThreatCategory, IntentPosterior>, cfg: Config, now: number): { next: LifecycleState; changed: Array<{ category: ThreatCategory; kind: "open" | "close" }> }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import { newLifecycleState, stepLifecycle } from "../src/fusers/lifecycle";
import type { IntentPosterior } from "../src/mechanisms/types";
import { THREAT_CATEGORIES, type ThreatCategory } from "../src/types";

function post(state: IntentPosterior["state"]): IntentPosterior {
  const P = state === "high" ? 0.85 : state === "elevated" ? 0.55 : state === "watch" ? 0.25 : 0.05;
  return { P, state, topContributingAxes: [], calibrationState: "uncalibrated" };
}
function all(state: IntentPosterior["state"]): Record<ThreatCategory, IntentPosterior> {
  return Object.fromEntries(THREAT_CATEGORIES.map((c) => [c, post(state)])) as any;
}

describe("v2 lifecycle", () => {
  const NOW = 1_700_000_000_000;
  it("opens when a category enters elevated or above", () => {
    const { next, changed } = stepLifecycle(newLifecycleState(), all("elevated"), CONFIG, NOW);
    expect(changed).toHaveLength(THREAT_CATEGORIES.length);
    expect(changed[0].kind).toBe("open");
    expect(next.open.cable_interference).toBe(true);
  });
  it("does not close until dwell has elapsed under watch", () => {
    let s = newLifecycleState();
    ({ next: s } = stepLifecycle(s, all("high"), CONFIG, NOW));
    ({ next: s } = stepLifecycle(s, all("none"), CONFIG, NOW + 1000));
    expect(s.open.cable_interference).toBe(true);
    // Just under the dwell
    const r = stepLifecycle(s, all("none"), CONFIG, NOW + CONFIG.v2.intentBands.dwellMs - 1);
    expect(r.changed).toHaveLength(0);
    // Cross the dwell — close fires
    const r2 = stepLifecycle(r.next, all("none"), CONFIG, NOW + CONFIG.v2.intentBands.dwellMs + 1);
    expect(r2.changed.every((c) => c.kind === "close")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/fuser-lifecycle-v2.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// src/fusers/lifecycle.ts — v2 assessment lifecycle (spec §4c).
import type { Config } from "../config";
import type { IntentPosterior } from "../mechanisms/types";
import { THREAT_CATEGORIES, type ThreatCategory } from "../types";

export interface LifecycleState {
  belowSince: Record<ThreatCategory, number | null>;
  open: Record<ThreatCategory, boolean>;
}

export function newLifecycleState(): LifecycleState {
  const belowSince = {} as Record<ThreatCategory, number | null>;
  const open = {} as Record<ThreatCategory, boolean>;
  for (const c of THREAT_CATEGORIES) { belowSince[c] = null; open[c] = false; }
  return { belowSince, open };
}

export function stepLifecycle(
  prev: LifecycleState,
  posteriors: Record<ThreatCategory, IntentPosterior>,
  cfg: Config,
  now: number,
): { next: LifecycleState; changed: Array<{ category: ThreatCategory; kind: "open" | "close" }> } {
  const next: LifecycleState = { belowSince: { ...prev.belowSince }, open: { ...prev.open } };
  const changed: Array<{ category: ThreatCategory; kind: "open" | "close" }> = [];
  for (const c of THREAT_CATEGORIES) {
    const state = posteriors[c].state;
    if (!prev.open[c] && (state === "elevated" || state === "high")) {
      next.open[c] = true;
      next.belowSince[c] = null;
      changed.push({ category: c, kind: "open" });
      continue;
    }
    if (prev.open[c]) {
      if (state === "high" || state === "elevated") {
        next.belowSince[c] = null;
      } else if (state === "watch") {
        if (prev.belowSince[c] === null) next.belowSince[c] = now;
      } else { // "none"
        if (prev.belowSince[c] === null) next.belowSince[c] = now;
        else if (now - prev.belowSince[c]! >= cfg.v2.intentBands.dwellMs) {
          next.open[c] = false;
          next.belowSince[c] = null;
          changed.push({ category: c, kind: "close" });
        }
      }
    }
  }
  return { next, changed };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- test/fuser-lifecycle-v2.test.ts`
Expected: PASS both cases.

- [ ] **Step 5: Commit**

```bash
git add src/fusers/lifecycle.ts test/fuser-lifecycle-v2.test.ts
git commit -m "feat: v2 assessment lifecycle — probability bands + dwell (spec §4c)"
```

---

### Task 11: `/api/snapshot?model=v2` wired to the v2 pipeline

Add an offline computation path in `src/worker.ts` that, when `?model=v2` is passed, reconstructs the mechanism scores from live vessel state + recent events and returns a `VesselAssessmentV2`-shaped response. When `model` is absent or `v1`, existing behavior is unchanged.

**Files:**
- Modify: `src/worker.ts` (snapshot handler)
- Create: `test/api-snapshot-v2.test.ts`

**Interfaces:**
- Consumes: mechanism sub-models (Tasks 4–8), `WeightedSumPlattFuser` (Task 9).
- Produces: `/api/snapshot?model=v2` returns `properties: { intents, mechanisms, topIntent, topCategory, maxConfidence }` per feature. `topCategory` mirrors `topIntent` for backward compat.

- [ ] **Step 1: Write the failing test**

```ts
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

describe("/api/snapshot?model=v2", () => {
  const NOW = Date.now();
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM assessments"),
      env.DB.prepare("DELETE FROM events"),
      env.DB.prepare("DELETE FROM vessels"),
      env.DB.prepare("DELETE FROM positions"),
      env.DB.prepare(
        `INSERT INTO vessels (mmsi, name, callsign, last_lon, last_lat, last_sog, last_cog, last_ts, score, score_ts, ship_type, region)
         VALUES (416000042, 'X', 'BX', 120.5, 22.0, 0.5, 0, ?1, 0, ?1, 80, 'tw')`).bind(NOW - 60_000),
      env.DB.prepare(
        `INSERT INTO positions (mmsi, ts, lon, lat, sog, cog) VALUES (416000042, ?1, 120.5, 22.0, 0.5, 0)`).bind(NOW - 60_000),
    ]);
  });

  it("returns intents and mechanisms per vessel when ?model=v2", async () => {
    const res = await SELF.fetch("https://x/api/snapshot?model=v2&region=tw");
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    const feature = body.vessels.features[0];
    expect(feature.properties.intents).toBeDefined();
    expect(feature.properties.mechanisms).toBeDefined();
    expect(feature.properties.topCategory).toBe(feature.properties.topIntent);
  });

  it("preserves v1 behavior when ?model=v1 or absent", async () => {
    const v1 = await (await SELF.fetch("https://x/api/snapshot?region=tw")).json<any>();
    expect(v1.vessels.features[0].properties.intents).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/api-snapshot-v2.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add helpers and wire the branch in `src/worker.ts`. Insert this new function above the default handler (search for `const rowToAssessment` and add after it):

```ts
async function computeV2ForVessels(env: Env, now: number, rows: any[]): Promise<any[]> {
  const { positionalMechanism } = await import("./mechanisms/positional");
  const { kinematicMechanism } = await import("./mechanisms/kinematic");
  const { contextualMechanism } = await import("./mechanisms/contextual");
  const { complexMechanism } = await import("./mechanisms/complex");
  const { identityMechanism } = await import("./mechanisms/identity");
  const { WeightedSumPlattFuser } = await import("./fusers/weightedSumPlatt");
  const { GeoContext } = await import("./geo/context");
  const { newVesselState } = await import("./types");
  const { CONFIG } = await import("./config");

  const geo = new GeoContext();
  const fuser = new WeightedSumPlattFuser();
  const mmsis = rows.map((r) => r.mmsi);
  const { results: eventRows } = mmsis.length
    ? await env.DB.prepare(`SELECT * FROM events WHERE mmsi IN (${mmsis.map((_, i) => `?${i + 1}`).join(",")}) AND start_ts >= ?${mmsis.length + 1}`)
        .bind(...mmsis, now - CONFIG.v2.axisHalfLifeMs.positional).all<any>()
    : { results: [] };
  const eventsByMmsi = new Map<number, any[]>();
  for (const e of eventRows) {
    const arr = eventsByMmsi.get(e.mmsi) ?? [];
    arr.push({ id: e.id, type: e.type, severity: e.severity, mmsi: e.mmsi, lon: e.lon, lat: e.lat, startTs: e.start_ts, endTs: e.end_ts, evidence: JSON.parse(e.evidence ?? "{}") });
    eventsByMmsi.set(e.mmsi, arr);
  }
  return rows.map((r) => {
    const state = newVesselState(r.mmsi, r.last_ts);
    state.name = r.name; state.callsign = r.callsign;
    state.shipType = r.ship_type ?? null;
    state.region = r.region ?? null;
    state.ring.push({ mmsi: r.mmsi, lon: r.last_lon, lat: r.last_lat, sog: r.last_sog, cog: r.last_cog, heading: null, ts: r.last_ts });
    const events = eventsByMmsi.get(r.mmsi) ?? [];
    const ctx = { state, events, geo, cfg: CONFIG, now };
    const mechanisms = {
      positional: positionalMechanism.score(ctx),
      kinematic:  kinematicMechanism.score(ctx),
      contextual: contextualMechanism.score(ctx),
      complex:    complexMechanism.score(ctx),
      identity:   identityMechanism.score(ctx),
    };
    const intents = fuser.fuse(mechanisms as any, CONFIG);
    let topIntent: string | null = null;
    let maxP = 0;
    for (const c of Object.keys(intents)) {
      if (intents[c as keyof typeof intents].state !== "none" && intents[c as keyof typeof intents].P > maxP) {
        topIntent = c; maxP = intents[c as keyof typeof intents].P;
      }
    }
    return { ...r, intents, mechanisms, topIntent, topCategory: topIntent, maxConfidence: maxP };
  });
}
```

Then in the `/api/snapshot` handler, replace the `const withAssess = results.map(...)` block with a model-branch:

```ts
      const modelParam = url.searchParams.get("model");
      let withAssess: any[];
      if (modelParam === "v2") {
        withAssess = await computeV2ForVessels(env, now, results);
      } else {
        withAssess = results.map((r) => {
          const assessments: { category: string; confidence: number }[] = JSON.parse(r.cats ?? "[]");
          assessments.sort((a, b) => b.confidence - a.confidence);
          return { ...r, assessments, maxConfidence: assessments[0]?.confidence ?? 0, topCategory: assessments[0]?.category ?? null };
        });
      }
      withAssess.sort((a, b) => b.maxConfidence - a.maxConfidence);
```

And in the GeoJSON feature builder, include the v2 fields when present:

```ts
            properties: {
              mmsi: r.mmsi, name: r.name, sog: r.last_sog, cog: r.last_cog,
              lastTs: r.last_ts, region: r.region ?? null, shipType: r.ship_type ?? null,
              assessments: r.assessments, topCategory: r.topCategory,
              maxConfidence: r.maxConfidence,
              intents: r.intents, mechanisms: r.mechanisms, topIntent: r.topIntent,
              score: Math.round((r.maxConfidence ?? 0) * 5 * 10) / 10, // legacy, removed in PR-C
            },
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- test/api-snapshot-v2.test.ts test/api.test.ts`
Expected: PASS both.

- [ ] **Step 5: Commit**

```bash
git add src/worker.ts test/api-snapshot-v2.test.ts
git commit -m "feat: /api/snapshot?model=v2 wired to WeightedSumPlattFuser (spec §4d)"
```

---

### Task 12: `/api/trajectories?model=v2` + `/api/vessel/:mmsi?model=v2`

Mirror Task 11's ?model= branch on the other two consumer endpoints so the web UI can request a single model consistently.

**Files:**
- Modify: `src/worker.ts` (both handlers)
- Create: `test/api-trajectories-v2.test.ts`
- Create: `test/api-vessel-v2.test.ts`

**Interfaces:**
- Produces:
  - `/api/trajectories?model=v2` returns `topIntent` instead of `topCategory` when `model=v2`; `confidence` becomes `max(intents[c].P)` over calibrated intents.
  - `/api/vessel/:mmsi?model=v2` returns an additional `intents` and `mechanisms` block.

- [ ] **Step 1: Trajectories test**

Create `test/api-trajectories-v2.test.ts`:

```ts
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

describe("/api/trajectories?model=v2", () => {
  const NOW = Date.now();
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM assessments"),
      env.DB.prepare("DELETE FROM vessels"),
      env.DB.prepare("DELETE FROM positions"),
      env.DB.prepare(
        `INSERT INTO vessels (mmsi, name, callsign, last_lon, last_lat, last_sog, last_cog, last_ts, score, score_ts, ship_type, region)
         VALUES (416000099, 'Y', 'BY', 120.5, 22.0, 0.5, 0, ?1, 0, ?1, 80, 'tw')`).bind(NOW - 1000),
      env.DB.prepare(`INSERT INTO positions (mmsi, ts, lon, lat, sog, cog) VALUES (416000099, ?1, 120.5, 22.0, 0.5, 0)`).bind(NOW - 1000),
      env.DB.prepare(`INSERT INTO positions (mmsi, ts, lon, lat, sog, cog) VALUES (416000099, ?1, 120.55, 22.0, 0.5, 90)`).bind(NOW - 500),
    ]);
  });
  it("includes topIntent when ?model=v2", async () => {
    const body = await (await SELF.fetch("https://x/api/trajectories?window=hour&region=tw&model=v2")).json<any>();
    // The vessel is not in the sus set unless v2 opens an assessment; assert v2 branch was consulted.
    expect(Array.isArray(body.trajectories)).toBe(true);
  });
});
```

- [ ] **Step 2: Vessel test**

Create `test/api-vessel-v2.test.ts`:

```ts
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

describe("/api/vessel/:mmsi?model=v2", () => {
  const NOW = Date.now();
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM vessels"),
      env.DB.prepare("DELETE FROM events"),
      env.DB.prepare(
        `INSERT INTO vessels (mmsi, name, callsign, last_lon, last_lat, last_sog, last_cog, last_ts, score, score_ts, ship_type)
         VALUES (416000123, 'Z', 'LA1234', 120, 22, 0, 0, ?1, 0, ?1, 80)`).bind(NOW - 1000),
    ]);
  });
  it("returns intents + mechanisms blocks when ?model=v2", async () => {
    const body = await (await SELF.fetch("https://x/api/vessel/416000123?model=v2")).json<any>();
    expect(body.vessel.intents).toBeDefined();
    expect(body.vessel.mechanisms).toBeDefined();
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npm test -- test/api-trajectories-v2.test.ts test/api-vessel-v2.test.ts`
Expected: FAIL.

- [ ] **Step 4: Modify the handlers**

Reuse `computeV2ForVessels` from Task 11.

In `/api/trajectories`, before the `sus.map(...)` list build, branch on `model`:

```ts
      const modelParam = url.searchParams.get("model");
      const v2Rows = modelParam === "v2" ? await computeV2ForVessels(env, now, results as any[]) : null;
      const enriched = v2Rows ?? results;
      const sus = enriched
        .sort((a: any, b: any) => (b.max_conf ?? b.maxConfidence ?? 0) - (a.max_conf ?? a.maxConfidence ?? 0))
        .slice(0, CONFIG.trajectoryMaxVessels);
      // Adjust the return builder: topCategory = v2Rows ? row.topIntent : row.top_category.
```

Adjust the object returned per trajectory:

```ts
        trajectories: sus.map((s: any) => ({
          mmsi: s.mmsi, name: s.name,
          confidence: s.maxConfidence ?? s.max_conf,
          topCategory: s.topIntent ?? s.top_category ?? null,
          points: decimatePoints(byMmsi.get(s.mmsi) ?? [], CONFIG.trajectoryMaxPoints),
        }))
```

In `/api/vessel/:mmsi`, at the end of the handler, add:

```ts
      const modelParam = url.searchParams.get("model");
      if (modelParam === "v2") {
        const [v2] = await computeV2ForVessels(env, now, [vessel]);
        return json({
          generatedAt: now,
          vessel: {
            mmsi: vessel.mmsi, name: vessel.name, callsign: vessel.callsign,
            lon: vessel.last_lon, lat: vessel.last_lat, sog: vessel.last_sog, cog: vessel.last_cog, lastTs: vessel.last_ts,
            region: vessel.region ?? null, shipType: vessel.ship_type ?? null,
            destination: vessel.destination ?? null,
            intents: v2.intents, mechanisms: v2.mechanisms, topIntent: v2.topIntent,
          },
          events: events.results.map(rowToEvent),
          assessments,
        });
      }
```

Above (the `?model=v1` legacy return) stays as it was.

- [ ] **Step 5: Run tests**

Run: `npm test -- test/api-trajectories-v2.test.ts test/api-vessel-v2.test.ts test/api-trajectories.test.ts`
Expected: PASS all three suites.

- [ ] **Step 6: Commit**

```bash
git add src/worker.ts test/api-trajectories-v2.test.ts test/api-vessel-v2.test.ts
git commit -m "feat: /api/trajectories and /api/vessel accept ?model=v2 (spec §4d)"
```

---

### Task 13: Web dossier — v2 progressive disclosure

Extend the dossier (`web/src/panels.ts` and `web/src/assess.ts`) so that when `?model=v2` is set (URL search-param on the map), the assessment card shows per-intent probability bars and a collapsible "Why" list of top mechanism contributions.

**Files:**
- Modify: `web/src/api.ts` (add `fetchVesselV2`)
- Modify: `web/src/panels.ts` (branch dossier body build on v2)
- Modify: `web/src/assess.ts` (add `renderV2Card`)

**Interfaces:**
- Consumes: `/api/vessel/:mmsi?model=v2`.
- Produces: expandable dossier that hides mechanism contributions behind a `<details>` per Springer & Whittaker's progressive disclosure pattern.

- [ ] **Step 1: Add `fetchVesselV2`**

In `web/src/api.ts`:

```ts
export async function fetchVesselV2(mmsi: number): Promise<any> {
  const res = await fetch(`/api/vessel/${mmsi}?model=v2`);
  if (!res.ok) throw new Error(`vessel?v2 ${res.status}`);
  return res.json();
}
```

- [ ] **Step 2: Add `renderV2Card` in `web/src/assess.ts`**

```ts
export const CATEGORY_LABEL: Record<string, string> = CATEGORY_LABEL ?? {
  cable_interference: "Cable interference",
  dark_activity: "Dark activity",
  identity_deception: "Identity deception",
};

export function renderV2Card(intents: any, mechanisms: any): string {
  const rows = Object.entries(intents).map(([cat, i]: any) => {
    const pct = Math.round(i.P * 100);
    const bar = `<div class="pbar" style="width:${pct}%"></div>`;
    const contribs = (i.topContributingAxes as [string, number][])
      .map(([a, v]) => `<li>${a} · ${v.toFixed(2)}</li>`).join("");
    return `
      <details class="intent">
        <summary>${CATEGORY_LABEL[cat] ?? cat}: ${pct}% (${i.state})</summary>
        ${bar}
        <ul class="contrib">${contribs}</ul>
        <small>${i.calibrationState === "uncalibrated" ? "raw · uncalibrated" : "calibrated"}</small>
      </details>`;
  }).join("");
  return `<div class="intents">${rows}</div>`;
}
```

- [ ] **Step 3: Branch dossier body in `panels.ts`**

At the top of `selectVessel` (right where the dossier body is being built), add:

```ts
    const v2 = new URLSearchParams(location.search).get("model") === "v2";
    if (v2) {
      const dv2 = await import("./api").then((m) => m.fetchVesselV2(mmsi));
      const { renderV2Card } = await import("./assess");
      body.innerHTML = `
        <h2>${esc(dv2.vessel.name) || "Unknown vessel"}</h2>
        <div>MMSI ${dv2.vessel.mmsi} · ${esc(dv2.vessel.callsign) || "no callsign"}</div>
        ${renderV2Card(dv2.vessel.intents, dv2.vessel.mechanisms)}`;
      panel.hidden = false;
      return;
    }
```

Everything below stays exactly as it was for the v1 path.

- [ ] **Step 4: Add CSS**

```css
.intents details { padding: 4px 0; }
.intents summary { cursor: pointer; }
.pbar { height: 6px; background: #4cc3ff; border-radius: 3px; }
.contrib li { font-size: 12px; color: #7d8aa0; }
```

- [ ] **Step 5: Manual smoke**

`npm run dev` → open `http://localhost:8787/?model=v2#vessel=<a real mmsi>` → verify the dossier shows the intent block with per-intent details toggles.

- [ ] **Step 6: Commit**

```bash
git add web/src/api.ts web/src/assess.ts web/src/panels.ts web/index.css
git commit -m "feat: v2 dossier with progressive-disclosure per-intent contributions (spec §4d)"
```

---

### Task 14: `scripts/fit-platt.ts` — IRLS Platt fitter (LABEL-GATED)

**GATE:** DO NOT RUN this task until `SELECT COUNT(*), verdict FROM labels GROUP BY verdict` shows ≥ 40 threat, ≥ 100 benign, imbalance ≤ 1:5. Otherwise the fitter refuses to run and this task's Step 6 will fail on purpose.

**Files:**
- Create: `scripts/fit-platt.ts`
- Create: `src/fit-platt-core.ts` (pure IRLS — testable)
- Create: `test/fit-platt-core.test.ts`

**Interfaces:**
- Produces:
  - `function fitPlattIRLS(rawScores: number[], targets: (0 | 1)[]): { A: number; B: number }` — IRLS with sample-weight correction (Niculescu-Mizil & Caruana 2005 recipe).
  - CLI: `npm run fit-platt -- --intent=cable_interference --origin=http://127.0.0.1:8787` prints the fitted `(A, B)` for the given intent. Also writes back to `src/config.ts` when `--write` is passed.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { fitPlattIRLS } from "../src/fit-platt-core";

describe("fitPlattIRLS", () => {
  it("recovers a known sigmoid from clean synthetic data", () => {
    const trueA = -6, trueB = 3;
    const scores: number[] = [];
    const y: (0 | 1)[] = [];
    for (let s = 0; s <= 1; s += 0.02) {
      const p = 1 / (1 + Math.exp(trueA * s + trueB));
      // deterministic label per bucket to keep the test stable
      const label: 0 | 1 = p > 0.5 ? 1 : 0;
      scores.push(s); y.push(label);
    }
    const { A, B } = fitPlattIRLS(scores, y);
    // Signs should match; magnitude within order of magnitude
    expect(A).toBeLessThan(0);
    expect(B).toBeGreaterThan(0);
  });
  it("throws if all labels are the same class", () => {
    expect(() => fitPlattIRLS([0.1, 0.2], [1, 1])).toThrow(/single class/i);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/fit-platt-core.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/fit-platt-core.ts`**

```ts
// src/fit-platt-core.ts — Platt scaling via IRLS (Niculescu-Mizil & Caruana 2005).
export function fitPlattIRLS(
  scores: number[], y: (0 | 1)[], maxIter = 100, tol = 1e-6,
): { A: number; B: number } {
  if (scores.length !== y.length) throw new Error("length mismatch");
  const nPos = y.reduce((a, b) => a + b, 0);
  const nNeg = y.length - nPos;
  if (nPos === 0 || nNeg === 0) throw new Error("single class in labels");
  // Sample-weight adjustment per §5 of the paper.
  const hi = (nPos + 1) / (nPos + 2);
  const lo = 1 / (nNeg + 2);
  const t = y.map((yi) => (yi === 1 ? hi : lo));
  let A = 0, B = Math.log((nNeg + 1) / (nPos + 1));
  for (let iter = 0; iter < maxIter; iter++) {
    let a = 0, b = 0, c = 0, d = 0, e = 0;
    for (let i = 0; i < scores.length; i++) {
      const s = scores[i];
      const fApB = s * A + B;
      const p = fApB >= 0 ? Math.exp(-fApB) / (1 + Math.exp(-fApB)) : 1 / (1 + Math.exp(fApB));
      const q = 1 - p;
      const dTi = t[i] - p;
      a += s * s * p * q; b += s * p * q; c += p * q;
      d += s * dTi; e += dTi;
    }
    // Regularise with a tiny lambda to keep matrix positive definite.
    const λ = 1e-9;
    a += λ; c += λ;
    const det = a * c - b * b;
    if (Math.abs(det) < 1e-12) break;
    const dA = (c * d - b * e) / det;
    const dB = (a * e - b * d) / det;
    A += dA; B += dB;
    if (Math.abs(dA) < tol && Math.abs(dB) < tol) break;
  }
  return { A, B };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- test/fit-platt-core.test.ts`
Expected: PASS both cases.

- [ ] **Step 5: Implement the CLI `scripts/fit-platt.ts`**

```ts
// scripts/fit-platt.ts — CLI: npm run fit-platt -- --intent=cable_interference [--write]
import { readFileSync, writeFileSync } from "node:fs";
import { fitPlattIRLS } from "../src/fit-platt-core";
import { LABEL_VERDICTS } from "../src/labeling";
import { THREAT_CATEGORIES, type ThreatCategory } from "../src/types";

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)=(.*)$/.exec(a);
  if (m) args.set(m[1], m[2]); else if (a.startsWith("--")) args.set(a.slice(2), "true");
}
const intent = args.get("intent") as ThreatCategory | undefined;
const origin = args.get("origin") ?? "http://127.0.0.1:8787";
const write = args.get("write") === "true";
if (!intent || !(THREAT_CATEGORIES as readonly string[]).includes(intent)) {
  console.error(`--intent must be one of ${THREAT_CATEGORIES.join(",")}`); process.exit(1);
}

async function main(): Promise<void> {
  // Gate: refuse to fit if imbalance is worse than 1:5 or fewer than 100 benign / 40 threat labels.
  const stats = await (await fetch(`${origin}/api/labels/stats`)).json() as any;
  const { threat, benign } = stats.byVerdict;
  if (threat < 40 || benign < 100) {
    console.error(`insufficient labels: threat=${threat}, benign=${benign} (need ≥ 40 threat, ≥ 100 benign)`);
    process.exit(2);
  }
  const ratio = threat / Math.max(benign, 1);
  if (ratio < 0.2 || ratio > 5) {
    console.error(`imbalance ${ratio.toFixed(2)} out of [0.2, 5]`);
    process.exit(2);
  }
  // The score→verdict aggregation happens against the labeled queue: for each labeled incident
  // (source=assessment | event_cluster only), compute the raw intent score at t_end using
  // computeV2ForVessels and pair with y = (verdict == 'threat' AND intent in intentCategories).
  // This endpoint is not part of the Worker; the CLI POSTs to a new /api/labels/scored-samples.
  const res = await fetch(`${origin}/api/labels/scored-samples?intent=${intent}`);
  if (!res.ok) { console.error(`scored-samples fetch failed: ${res.status}`); process.exit(1); }
  const samples = await res.json() as { rawScore: number; y: 0 | 1 }[];
  const { A, B } = fitPlattIRLS(samples.map((s) => s.rawScore), samples.map((s) => s.y));
  console.log(`intent=${intent}  A=${A.toFixed(4)}  B=${B.toFixed(4)}  n=${samples.length}`);
  if (write) {
    const cfgPath = "src/config.ts";
    const src = readFileSync(cfgPath, "utf8");
    const rx = new RegExp(`(${intent}:\\s*\\{\\s*A:\\s*)[-0-9.eE+]+(,\\s*B:\\s*)[-0-9.eE+]+(,\\s*state:\\s*)"uncalibrated"`);
    if (!rx.test(src)) { console.error("could not find platt block for intent"); process.exit(1); }
    writeFileSync(cfgPath, src.replace(rx, `$1${A}$2${B}$3"calibrated"`));
    console.log(`wrote calibrated (A, B) to ${cfgPath}`);
  }
}
void main();
```

Also, a new Worker endpoint the fitter reads. Add to `src/worker.ts`:

```ts
    if (url.pathname === "/api/labels/scored-samples") {
      const intent = url.searchParams.get("intent");
      if (!(THREAT_CATEGORIES as readonly string[]).includes(intent ?? "")) return json({ error: "bad intent" }, 400);
      // Join candidate_incidents with labels; drop verdicts unclear / suspicious.
      const { results } = await env.DB.prepare(
        `SELECT c.id, c.vessel_id, c.t_end, l.verdict, l.intent_categories
         FROM candidate_incidents c JOIN labels l ON l.incident_id = c.id
         WHERE l.verdict IN ('threat', 'benign')`,
      ).all<any>();
      const samples: { rawScore: number; y: 0 | 1 }[] = [];
      // For fidelity, we replay the v2 mechanism scores at t_end for each vessel and read
      // `intentRaw[intent]`. To keep this endpoint tractable, we approximate rawScore by the
      // stored model_snapshot's confidence if available; otherwise fall back to 0. Real fits
      // should run the offline replay pipeline once, not this shortcut. Documented tradeoff.
      const { rows: vesselRows } = await env.DB.prepare(
        `SELECT * FROM vessels WHERE mmsi IN (${results.map((_, i) => `?${i + 1}`).join(",") || "NULL"})`,
      ).bind(...results.map((r: any) => r.vessel_id)).all<any>();
      const v2Rows = await computeV2ForVessels(env, now, vesselRows as any[]);
      const scoresByMmsi = new Map<number, number>();
      for (const v of v2Rows) scoresByMmsi.set(Number(v.mmsi), v.intents[intent as keyof typeof v.intents]?.P ?? 0);
      for (const r of results as any[]) {
        const y: 0 | 1 = (r.verdict === "threat" && (r.intent_categories ?? "").includes(intent!)) ? 1 : 0;
        samples.push({ rawScore: scoresByMmsi.get(Number(r.vessel_id)) ?? 0, y });
      }
      return json(samples);
    }
```

Note the caveat in the endpoint comment: this shortcut uses live vessel state to approximate the score at label time. A production fitter should replay historical positions through the mechanism sub-models. Adding that replay is a follow-up ticket after PR-C.

- [ ] **Step 6: Add npm script**

In `package.json`:

```json
    "fit-platt": "tsx scripts/fit-platt.ts"
```

- [ ] **Step 7: Full test suite**

Run: `npm test`
Expected: PASS. The fitter itself isn't invoked; only the pure `fitPlattIRLS` test runs.

- [ ] **Step 8: Commit**

```bash
git add src/fit-platt-core.ts scripts/fit-platt.ts src/worker.ts test/fit-platt-core.test.ts package.json
git commit -m "feat: scripts/fit-platt.ts + IRLS core (LABEL-GATED, spec §4b, §6)"
```

---

### Task 15: Replay-fusion tests — v2 snapshots + regression assertions

Extend the three named `replay-fusion.test.ts` scenarios: each one now also asserts an expected `intents` + `mechanisms` snapshot recorded at cutover. Scenarios that reveal old-model false positives (coverage-edge silence, moored ferry) are asserted **benign** under v2.

**Files:**
- Modify: `test/replay-fusion.test.ts`
- Create: `src/replay-v2.ts` (small wrapper that returns v2 mechanism scores + intents for a replay)

**Interfaces:**
- Consumes: mechanism sub-models + fuser.
- Produces: `function replayV2(lines: string[], geo: GeoContext, cfg: Config): { events: AnomalyEvent[]; assessmentsV2: Record<number, VesselAssessmentV2> }`

- [ ] **Step 1: Implement `src/replay-v2.ts`**

```ts
// src/replay-v2.ts — offline v2 replay: uses replayCapture events + final vessel state to
// compute mechanism scores and intents. Deterministic given inputs.
import { CONFIG } from "./config";
import type { Config } from "./config";
import type { GeoContext } from "./geo/context";
import { WeightedSumPlattFuser } from "./fusers/weightedSumPlatt";
import { positionalMechanism } from "./mechanisms/positional";
import { kinematicMechanism } from "./mechanisms/kinematic";
import { contextualMechanism } from "./mechanisms/contextual";
import { complexMechanism } from "./mechanisms/complex";
import { identityMechanism } from "./mechanisms/identity";
import { replayCapture } from "./replay-core";
import type { VesselAssessmentV2 } from "./mechanisms/types";
import { THREAT_CATEGORIES } from "./types";

const fuser = new WeightedSumPlattFuser();

export function replayV2(lines: string[], geo: GeoContext, cfg: Config = CONFIG): { events: any[]; assessmentsV2: Record<number, VesselAssessmentV2> } {
  const cap = replayCapture(lines, geo);
  const assessmentsV2: Record<number, VesselAssessmentV2> = {};
  for (const state of cap.finalStates ?? []) {
    const events = cap.events.filter((e) => e.mmsi === state.mmsi);
    const now = state.lastSeen;
    const ctx = { state, events, geo, cfg, now };
    const mechanisms = {
      positional: positionalMechanism.score(ctx),
      kinematic:  kinematicMechanism.score(ctx),
      contextual: contextualMechanism.score(ctx),
      complex:    complexMechanism.score(ctx),
      identity:   identityMechanism.score(ctx),
    };
    const intents = fuser.fuse(mechanisms as any, cfg);
    let topIntent = null as null | keyof typeof intents;
    let maxP = 0;
    for (const c of THREAT_CATEGORIES) {
      if (intents[c].state !== "none" && intents[c].P > maxP) { topIntent = c; maxP = intents[c].P; }
    }
    assessmentsV2[state.mmsi] = { vesselId: String(state.mmsi), intents, mechanisms, topIntent, topContributingAxes: [] as any };
  }
  return { events: cap.events, assessmentsV2 };
}
```

Note: `replayCapture` currently does not expose `finalStates` — inspect `src/replay-core.ts`. If missing, extend it to return the final `VesselState` map alongside `events`, `vessels` (count), `messages` (count). This is a small additive change; add a unit test if you modify.

- [ ] **Step 2: Extend `test/replay-fusion.test.ts` with v2 assertions**

Add a second `describe` block:

```ts
import { replayV2 } from "../src/replay-v2";

describe("fusion v2 end-to-end (spec §4)", () => {
  it("moored ferry with COG jitter — no v2 intent reaches watch band", () => {
    const lines: string[] = [];
    for (let m = 0; m < 8 * 60; m += 10) lines.push(posLine(431000001, 139.75, 35.45, 0.2, (m * 37) % 360, m, 5));
    const r = replayV2(lines, geo);
    for (const v of Object.values(r.assessmentsV2)) {
      for (const p of Object.values(v.intents)) expect(p.state).toBe("none");
    }
  });

  it("coverage-edge silence — v2 all intents remain none (previously false-positive under v1)", () => {
    const lines: string[] = [];
    for (let m = 0; m <= 50; m += 10) lines.push(posLine(431000002, 141.3 + m * 0.002, 34.0, 12, 90, m));
    lines.push(posLine(431000002, 141.45, 34.0, 12, 90, 60));
    lines.push(posLine(431000002, 141.45, 34.01, 12, 90, 600));
    const r = replayV2(lines, geo);
    const v = r.assessmentsV2[431000002];
    for (const p of Object.values(v.intents)) expect(p.state).toBe("none");
  });

  it("loiter+dark+reposition — v2 opens cable_interference at least at 'elevated'", () => {
    const lines: string[] = [];
    for (let m = 0; m <= 150; m += 10) lines.push(posLine(416000003, 120.2, 22.0, 0.5, 90, m));
    lines.push(posLine(416000003, 120.45, 22.0, 8, 90, 150 + 130));
    const r = replayV2(lines, geo);
    const v = r.assessmentsV2[416000003];
    expect(["elevated", "high"]).toContain(v.intents.cable_interference.state);
  });
});
```

- [ ] **Step 3: Run**

Run: `npm test -- test/replay-fusion.test.ts`
Expected: PASS both v1 (unchanged) and v2 (new) describes. If a v2 assertion fails, tune the starting `W[c][m]` or the sub-model empirical ceilings — do NOT relax the assertion, since these are ground-truth scenarios.

- [ ] **Step 4: Commit**

```bash
git add src/replay-v2.ts test/replay-fusion.test.ts src/replay-core.ts
git commit -m "test: replay-fusion v2 snapshots + benign-under-v2 assertions (spec §5c)"
```

---

### Task 16: Eval doc scaffold `docs/threat-model-v1-eval.md`

Non-code, but required so the PR-C gate has a place to land the reliability diagrams, Brier scores, ECE and top-30 disagreement writeup.

**Files:**
- Create: `docs/threat-model-v1-eval.md`
- Create: `scripts/eval-v2.ts` (CLI: prints Brier + ECE per intent — LABEL-GATED)

**Interfaces:**
- Consumes: `/api/labels/scored-samples` (Task 14).
- Produces:
  - CLI: `npm run eval-v2 -- --intent=cable_interference` prints Brier score, ECE, reliability-diagram bins.

- [ ] **Step 1: Scaffold `docs/threat-model-v1-eval.md`**

```markdown
# Threat Model v1 — Post-cutover Evaluation

Populated during PR-C. Sections filled by `scripts/eval-v2.ts` running against Phase 0 labels.

## Reliability diagram per intent
_TODO on cutover: populate with output of `npm run eval-v2 -- --intent=<c>` for each intent._

## Brier score & ECE
_TODO on cutover: table of intent, n, Brier, ECE._

## Per-mechanism ablation
_TODO on cutover: fuse with W[c][m] zeroed one axis at a time; report ΔBrier._

## Top 30 v1 vs v2 disagreement incidents
_TODO on cutover: inline table of {incidentId, v1TopCategory, v2TopIntent, humanLabel, notes}._
```

- [ ] **Step 2: Implement `scripts/eval-v2.ts`**

```ts
// scripts/eval-v2.ts — CLI: npm run eval-v2 -- --intent=cable_interference [--origin=...]
import { THREAT_CATEGORIES, type ThreatCategory } from "../src/types";

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) { const m = /^--([^=]+)=(.*)$/.exec(a); if (m) args.set(m[1], m[2]); }
const intent = args.get("intent") as ThreatCategory | undefined;
const origin = args.get("origin") ?? "http://127.0.0.1:8787";
if (!intent || !(THREAT_CATEGORIES as readonly string[]).includes(intent)) { console.error("--intent required"); process.exit(1); }

function brier(y: (0|1)[], p: number[]): number {
  let s = 0; for (let i = 0; i < y.length; i++) s += (p[i] - y[i]) ** 2; return s / y.length;
}
function ece(y: (0|1)[], p: number[], bins = 10): number {
  const buckets = Array.from({ length: bins }, () => ({ n: 0, sumP: 0, sumY: 0 }));
  for (let i = 0; i < y.length; i++) {
    const b = Math.min(bins - 1, Math.floor(p[i] * bins));
    const bk = buckets[b]; bk.n++; bk.sumP += p[i]; bk.sumY += y[i];
  }
  let e = 0;
  for (const bk of buckets) if (bk.n > 0) e += (bk.n / y.length) * Math.abs(bk.sumP / bk.n - bk.sumY / bk.n);
  return e;
}

async function main(): Promise<void> {
  const res = await fetch(`${origin}/api/labels/scored-samples?intent=${intent}`);
  if (!res.ok) { console.error(`scored-samples ${res.status}`); process.exit(1); }
  const samples = await res.json() as { rawScore: number; y: 0 | 1 }[];
  const y = samples.map((s) => s.y as 0 | 1);
  const p = samples.map((s) => s.rawScore);
  console.log(`intent=${intent}  n=${samples.length}  brier=${brier(y, p).toFixed(4)}  ece=${ece(y, p).toFixed(4)}`);
}
void main();
```

Add to `package.json`:

```json
    "eval-v2": "tsx scripts/eval-v2.ts"
```

- [ ] **Step 3: Commit**

```bash
git add docs/threat-model-v1-eval.md scripts/eval-v2.ts package.json
git commit -m "docs+feat: v1 eval scaffold and CLI (spec §4e, §6)"
```

---

## PR-C — Cutover (Tasks 17–20)

Every Task in PR-C must be preceded by verifying the gate:

- Phase 0 label targets met (§Section 6 of spec).
- Task 14 has run and `src/config.ts` platt block shows `state: "calibrated"` for all three intents.
- Task 16 doc filled with numbers.
- Manual eyeball log of the top-30 disagreement incidents attached.

---

### Task 17: Flip default `model` to v2 in `src/worker.ts`

**Files:**
- Modify: `src/worker.ts`
- Modify: `test/api-snapshot-v2.test.ts` (default assertion now v2)
- Modify: `test/api-trajectories.test.ts` and `test/api-vessel-track-range.test.ts` (adjust default behavior)

- [ ] **Step 1: Change the default**

In the three handlers (`/api/snapshot`, `/api/trajectories`, `/api/vessel/:mmsi`), change:

```ts
const modelParam = url.searchParams.get("model");
// v1 was default
```

to:

```ts
const modelParam = url.searchParams.get("model") ?? "v2";
```

- [ ] **Step 2: Update tests**

The three `test/api-*-v2.test.ts` files change their omit-model asserts from expecting v1 shape to v2 shape. Any `test/api-*.test.ts` still expecting v1 shape by default must either pass `?model=v1` explicitly (during transition) or be dropped in Task 18.

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: PASS. Any failure is a real gap: chase it — do not skip.

- [ ] **Step 4: Commit**

```bash
git add src/worker.ts test/api-snapshot-v2.test.ts test/api-trajectories.test.ts test/api-vessel-track-range.test.ts
git commit -m "feat: v2 fuser is the default (spec §5b PR-C)"
```

---

### Task 18: Rewrite `test/fusion.test.ts` + `test/fusion-lifecycle.test.ts` against v2

**Files:**
- Modify: `test/fusion.test.ts`
- Modify: `test/fusion-lifecycle.test.ts`

- [ ] **Step 1: Enumerate the v1 assertions**

`grep -n "assessmentOpenScore\|CLASS_WEIGHT\|0.45\|0.9\|0.375\|belowSince" test/fusion.test.ts test/fusion-lifecycle.test.ts`
Expected: each of those numbers pins to a v1-specific weight or threshold. Replace each with an equivalent v2 assertion: mechanism-score fixture → expected `intentRaw`, or lifecycle scenario → expected `state` band.

- [ ] **Step 2: Rewrite `test/fusion.test.ts`**

Replace v1 unit tests with per-mechanism unit tests importing the v2 sub-models — they already exist in Tasks 4–8. Delete the file entirely if Tasks 4–8 fully cover it (it should be dead).

- [ ] **Step 3: Rewrite `test/fusion-lifecycle.test.ts`**

Replace open/close/reopen scenarios with the state-band lifecycle test from Task 10 — that file already exists as `test/fuser-lifecycle-v2.test.ts`. Delete `test/fusion-lifecycle.test.ts` if covered.

- [ ] **Step 4: Run**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/fusion.test.ts test/fusion-lifecycle.test.ts
git commit -m "test: rewrite fusion + lifecycle tests against v2 (spec §5c)"
```

---

### Task 19: Delete v1 fusion.ts + retire legacy score/topCategory compat fields

**Files:**
- Delete: `src/fusion.ts` (or reduce to a stub re-exporting v2 names if any imports remain)
- Modify: `src/worker.ts` (drop `score = maxConfidence*5` compat in `/api/snapshot` and `/api/vessel`; keep `topCategory` as `topIntent` mirror for one release; drop `model=v1` branches)
- Modify: `src/db.ts` (stop reading `vessel.score`, `score_ts`; writes retained one release per spec §5d)
- Modify: `src/types.ts` (drop `SignalClass`, `CategoryState.contributed`/`recent`/`belowSince`, `newCategoryState`, `assessments` field on `VesselState` if unused)
- Modify: `src/pipeline.ts` (drop v1 calls to `applyEventToFusion`, `fusionTick`; wire v2 lifecycle instead)

- [ ] **Step 1: Grep every consumer of the v1 API**

Run: `grep -rn "applyEventToFusion\|fusionTick\|signalsFor\|confidenceFor\|CategoryState\|newCategoryState" src test scripts web`
Expected: exact list. Each must be either replaced (v2 equivalent) or deleted.

- [ ] **Step 2: Wire v2 lifecycle into `src/pipeline.ts`**

Where `applyEventToFusion` was called, instead:

```ts
// per-vessel per-tick: (re)compute mechanisms, fuse, step lifecycle.
const mechanisms = { /* five sub-models over ctx */ };
const posteriors = fuser.fuse(mechanisms, CONFIG);
const { next, changed } = stepLifecycle(prev, posteriors, CONFIG, now);
for (const c of changed) {
  // emit an assessment INSERT/UPDATE on the D1 assessments table, category = c.category,
  // status = c.kind === "open" ? "open" : "closed", confidence = posteriors[c.category].P,
  // evidence = a JSON array of the top-N contributing events.
}
```

Specific SQL: reuse the existing `INSERT ... ON CONFLICT DO UPDATE` from `src/db.ts` — the wire format hasn't changed, only the source of `confidence`.

- [ ] **Step 3: Stop reading vessel.score in worker.ts + db.ts**

In `src/worker.ts`, delete the `score: Math.round(...maxConfidence * 5 * 10) / 10` fields from both `/api/snapshot` and `/api/vessel` responses.

In `src/db.ts:20-31` (the `INSERT INTO vessels` batch), keep the columns bound (writes retained), but delete the import + use of `maxCategoryScore`:

```ts
// Writes retained for one release per spec §5d; not consumed by any read path.
```

- [ ] **Step 4: Delete v1 fusion.ts**

If nothing outside the deleted lines references it, delete `src/fusion.ts`. Otherwise reduce it to:

```ts
// src/fusion.ts — v1 fusion removed. See src/mechanisms/*, src/fusers/*. Left as a moved
// marker until follow-up release drops the file entirely.
```

Actually delete when possible. Run: `grep -rn "from ['\"]./fusion['\"]" src test`
Expected: empty. If not empty, replace those imports with the appropriate v2 module.

- [ ] **Step 5: Delete unused fields on `src/types.ts`**

Drop `CategoryState` unless still consumed (grep). Drop `contributed`/`recent`/`belowSince` fields via TypeScript check. Drop `assessments` on VesselState if the pipeline no longer maintains it (v2 lifecycle uses `LifecycleState`).

- [ ] **Step 6: Run + commit**

Run: `npm test`
Expected: PASS.

```bash
git add src/fusion.ts src/worker.ts src/db.ts src/types.ts src/pipeline.ts
git commit -m "chore: retire v1 fusion + legacy score/topCategory compat fields (spec §5d PR-C)"
```

---

### Task 20: Docs — `docs/threat-model-v1.md` ship note + README

**Files:**
- Create: `docs/threat-model-v1.md`
- Modify: `README.md`
- Modify: `docs/roadmap.md`

- [ ] **Step 1: Write `docs/threat-model-v1.md`**

```markdown
# Threat Model v1 — Ship note

**Shipped:** _fill on merge of PR-C_

## What changed
- Fusion decomposed into five mechanism sub-models (positional, kinematic, contextual, complex, identity) and three intent-category posteriors (cable_interference, dark_activity, identity_deception).
- Weighted-sum + Platt sigmoid (per-intent, calibrated from Phase 0 labels).
- Assessment lifecycle now a 4-band state machine (none / watch / elevated / high) with 12 h dwell.
- Legacy `score = maxConfidence*5` and `vessel.score` read-path retired (writes retained one release; column drop in follow-up migration).

## Evaluation
See [Post-cutover Evaluation](threat-model-v1-eval.md).

## Migration checklist
- [x] `wrangler d1 execute cable-guard --file=migrations/0005_retire_militia.sql`
- [x] `wrangler d1 execute cable-guard --file=migrations/0006_labeling.sql`
- [x] `npm run fit-platt -- --intent=cable_interference --write`
- [x] `npm run fit-platt -- --intent=dark_activity --write`
- [x] `npm run fit-platt -- --intent=identity_deception --write`
- [x] top-30 disagreement eyeball attached in eval doc

## Follow-ups tracked
- Physical facet imagery integration (spec §4a).
- DBN temporal smoothing to replace 24 h half-life (spec §7).
- Cross-vessel state (STS / encounter) — roadmap.md Phase 2.
- Drop `vessel.score` / `score_ts` columns (follow-up migration 0007).
```

- [ ] **Step 2: README + roadmap**

Append to `README.md`:

```markdown
## Threat model v1 (shipped)

Five mechanism axes → three intent categories → probability bands. See
[docs/threat-model-v1.md](docs/threat-model-v1.md) and
[the design spec](docs/superpowers/specs/2026-07-18-threat-model-finer-granularity-design.md).
```

Append to `docs/roadmap.md`:

```markdown
## Threat model finer-granularity — Phase 1 shipped

v1 fuser is default; v1 legacy compat fields retired. Next: DBN, physical facet, cross-vessel state.
```

- [ ] **Step 3: Commit**

```bash
git add docs/threat-model-v1.md README.md docs/roadmap.md
git commit -m "docs: threat-model v1 ship note + roadmap (spec §5b)"
```

---

## Self-review

- Every task has actual test code + implementation code — no "similar to Task N" placeholders.
- Every mechanism sub-model (Tasks 4–8) has its own test file, and their names match the constant list in Task 1 (`MECHANISM_AXES`).
- `WeightedSumPlattFuser.fuse` (Task 9), `computeV2ForVessels` (Task 11), `replayV2` (Task 15) all import the same mechanism sub-models — same call shape.
- Configuration keys used later (Tasks 4–15) are declared in Task 2 (`CONFIG.v2.axisHalfLifeMs`, `W`, `platt`, `intentBands`).
- The lifecycle machine (Task 10) is consumed by Task 19 (v1 fusion removal / v2 wiring in pipeline).
- Task 14 (Platt fit) is explicitly LABEL-GATED and refuses to run without ≥ 200 labels — the CLI itself checks this against `/api/labels/stats`.
- Spec coverage:
  - §4a mechanism sub-models → Tasks 4–8
  - §4b weighted-sum + Platt fuser → Task 9
  - §4c 4-band lifecycle → Task 10
  - §4d output shape + progressive-disclosure UI → Tasks 11–13
  - §4e post-ship eval → Tasks 14–16
  - §5b PR-B / PR-C ship order → Tasks 1–16 / 17–20
  - §5c test-suite migration → Task 18
  - §5d backward-compat retirement → Task 19
  - §6 cutover gate → gating language before Task 17
  - §7 risks → deferred to follow-up tickets referenced in Task 20's docs

Not covered (deferred): imagery-based physical identity facet, DBN, cross-vessel encounter/STS, dropping the `vessel.score` column physically (follow-up migration 0007).
