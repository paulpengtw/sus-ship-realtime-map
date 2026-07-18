# Finer-Granularity Threat Model — Design Spec

**Date:** 2026-07-18
**Status:** Approved by user (brainstorming session)
**Builds on:** [Threat Assessment Fusion](2026-07-17-threat-assessment-fusion-design.md)
**Phase:** 0 (labeling harness) + 1 (mechanism-axis / intent-category fuser)
**Explicitly deferred to later phases:** cross-vessel state (STS / encounter), imagery-based physical-identity facet, DBN temporal smoothing, VRNN trajectory-plausibility head, learned mechanism→intent weights (SVM / logistic / RF).

## 1. Motivation & scope

Today's fusion (`src/fusion.ts`, spec §3–4 of the 2026-07-17 doc) collapses every detector into one of three discrete class weights (strong = 1.0, medium = 0.45, weak = 0.15), sums into a per-category exponential-decay accumulator with a uniform 24 h half-life, opens at 0.6, closes at 0.2 after 12 h dwell. Detectors already compute continuous quantities (`durationMs`, `cogStdDeg`, `displacementM`, `silentMs`, `impliedSpeedKn`, `corridorDistanceM`) — **all discarded**. Multi-fact events collapse to one class per category. A 1 h 59 m loiter scores 0; 2 h scores full 0.45. `militia_presence` is scaffolded end-to-end but no code path raises it. `confidence = min(1, score/2)` saturates one strong signal at 0.5 with no calibration to any observed base rate. MID/callsign coverage is ~30 entries; anything else emits no signal.

### 1.1 Research grounding

Verified adversarially across 21 sources spanning six lenses (maritime anomaly detection, behavior-based decomposition, formal fusion methods, identity & context, spatiotemporal & trajectory, human factors). Six convergent themes shaped this design:

1. **Modular decomposition is the field standard.** Lane 2010 (QinetiQ, 5-node Bayesian network), Riveiro 2018 (WIREs, 5-way taxonomy), Pallotta/Vespe/Bryan 2013 (NATO TREAD), Global Fishing Watch 2024 (11 indicators in 3 families), Nascimento 2024 (5-module JDL stack), Hwang 2026 (equation-grounded A1/A2/A3). Debate is over the fuser topology, not whether to decompose.
2. **Continuous numeric evidence should modulate weights.** Wijaya 2023 loitering `F_{c,h,d}`, Welch 2022 BRT on gap features, arXiv 2606.29721 equation-grounded triggers, AIS-LLM CRI head — none use three discrete tiers.
3. **Identity deserves a multi-facet axis.** C4ADS Unmasked (2021) — registered / digital / physical facets, scored on **misalignment across facets**.
4. **Gated / layered composition wins for multi-fact evidence stacks.** Lloyd's List Seasearcher ARC (4-layer illicit voyage), Park/Cho/Son 2026 (three-tier hygiene → IMM → DBSCAN).
5. **Post-hoc calibration is mandatory.** Niculescu-Mizil & Caruana 2005 (Platt / isotonic).
6. **Finer granularity buys operator TRUST, not necessarily decision quality.** Laxar 2023 (BMC Medicine — trust 4→7/10, weight-on-advice unchanged), Karvetski & Mandel 2020 (Risk Analysis — statistical coherentization + aggregation beats operator-side ACH). Design implication: decompose for the dossier, let the model re-fuse. Springer & Whittaker 2020 progressive disclosure maps directly onto the existing halo + dossier UI.

### 1.2 Scope of this spec

**In scope, v1:** the two-phase project below.
**Out of scope, v1:** cross-vessel state, physical-identity from imagery, DBN, VRNN, learned mechanism→intent weights, per-axis half-life tuning, second-labeler workflows.

## 2. Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Primary goal | Set up for probabilistic output later — ship uncalibrated-until-labels shape now, calibrated posterior later |
| Axis scheme | Two independent layers: mechanism axes (evidence) + intent categories (framing). Mapping is a strategy interface swappable to Bayesian later |
| Calibration approach | Delay v1 until we curate labels — Phase 0 is a real labeling harness, not a bootstrap |
| Labelable unit | Per-vessel time-window incident `(vessel_id, tStart, tEnd)` |
| Candidate incident sources | All four: opened assessments · anomaly-event clusters · random negatives · hand-picked known incidents |
| Labeling UI | Extend the existing map UI in place (Review mode) |
| Retire `militia_presence` | Yes — it's scaffolded but never raised. Removed from `THREAT_CATEGORIES` in Phase 0 |
| Detectors | Behavior unchanged. `fusion.ts` starts consuming their numeric evidence bags instead of just `type` + class |

## 3. Phase 0 — Labeling harness

### 3a. D1 schema (two new tables)

```sql
-- Materialized candidate pool. Idempotent on id; regenerated on demand.
CREATE TABLE candidate_incidents (
  id TEXT PRIMARY KEY,           -- hash(vessel_id, t_start, t_end, source)
  vessel_id TEXT NOT NULL,
  t_start INTEGER NOT NULL,      -- ms epoch
  t_end   INTEGER NOT NULL,
  source  TEXT NOT NULL,         -- 'assessment' | 'event_cluster' | 'random_negative' | 'curated_positive'
  source_ref  TEXT,              -- assessment_id | cluster_key | 'random' | 'c4ads:unmasked-vlcc-1'
  created_at  INTEGER NOT NULL,
  model_snapshot TEXT,           -- JSON of what today's fusion said (for delta analysis)
  event_ids   TEXT               -- JSON array of AnomalyEvent ids inside the window
);
CREATE INDEX ix_candidate_source ON candidate_incidents(source, created_at);
CREATE INDEX ix_candidate_vessel ON candidate_incidents(vessel_id, t_start);

CREATE TABLE labels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id TEXT NOT NULL REFERENCES candidate_incidents(id),
  labeler TEXT NOT NULL,
  ts INTEGER NOT NULL,
  verdict TEXT NOT NULL,         -- 'threat' | 'suspicious' | 'benign' | 'unclear'
  intent_categories TEXT,        -- JSON array; required iff verdict IN ('threat','suspicious')
  labeler_confidence INTEGER,    -- 1..5
  notes TEXT,
  UNIQUE(incident_id, labeler)
);
CREATE INDEX ix_labels_verdict ON labels(verdict, ts);
```

### 3b. Materializer (`scripts/materialize-candidates.ts`)

Runs on demand; idempotent on `id` hash. Four candidate sources unioned:

1. **`assessment`** — every `assessments` row in a lookback window → `(vessel_id, open_ts − 30 min, close_ts + 30 min)`.
2. **`event_cluster`** — `AnomalyEvents` grouped by `(vessel_id, floor(ts / 30 min))`; keep buckets with ≥ 3 events AND no overlapping assessment. Excludes ones already covered by #1.
3. **`random_negative`** — uniformly sample K per UTC day from `(vessel_id, day)` tuples with ≥ 20 position rows and zero events; excludes any window overlapping #1 or #2.
4. **`curated_positive`** — read `data/curated-incidents.json` — hand-entered `(mmsi/imo, tStart, tEnd, note)`. Seed set from C4ADS Unmasked cases, GFW IUU list, public reporting. Committed to the repo.

Each candidate snapshots `model_snapshot` (current fusion's assessment/confidence at `t_end`) so post-Phase-1 we can measure delta versus the old formula.

### 3c. Labeling UI (extends `web/`)

- New "Review" mode toggle in the header (URL: `/?mode=review`).
- Left panel becomes the un-labeled incident queue, sortable by `source`; per-source progress bars ("42 / 60 assessments labeled").
- Selecting an incident: map replays the `t_start`→`t_end` window with track + event markers; dossier auto-populates from that window's data, not from "now".
- Right panel = label form: `verdict` radio · `intent_categories` checkboxes (enabled iff verdict ∈ {threat, suspicious}) · confidence slider (1–5) · notes textarea · "Save & next" button.
- New API routes on `src/worker.ts`: `POST /api/labels`, `GET /api/labels/queue?source=&limit=`, `GET /api/labels/stats`.

### 3d. Guardrails

- **No auto-labels.** Every label = human click. Auto-labeling quiet windows as benign leaks current fusion blind spots into ground truth.
- **Target composition** to unlock Phase 1 fitting: ≥ 200 total, ≥ 40 with `verdict=threat`, ≥ 100 with `verdict=benign`. Refuse to fit Platt if worse than 1:5 imbalance in either direction (warn, don't crash).
- **Train / eval split**: 80/20, held out **per-vessel** (a vessel is entirely in train or entirely in eval). Prevents vessel-identity leakage.
- Single-labeler for the first 50 incidents; second-labeler / IAA workflow deferred to Phase 2.

### 3e. Retiring `militia_presence`

Removed from `THREAT_CATEGORIES` in `src/types.ts:43`, `web/src/vessels.ts:CAT_MATCH`, `web/src/trajectories.ts`, and any tests that reference it. Persisted assessments referencing it (if any exist) are archived; no data migration beyond a one-shot `DELETE` in a migration. The intent-category checkboxes in the label form only offer the surviving three (`cable_interference`, `dark_activity`, `identity_deception`).

## 4. Phase 1 — Two-layer fuser

### 4a. Evidence layer — 5 mechanism sub-models

Each is a pure function `(EventStream, VesselState, WindowConfig) → MechanismScore` returning a continuous `[0, 1]` scalar plus a typed evidence bag. All numeric fields detectors already compute become inputs.

| Axis | What it captures | Signals (built from existing detector fields) |
|---|---|---|
| **Positional** | Deviation from expected route / corridor | `corridorDistanceM` graded (not boolean); angular deviation from expected COG at position; TSS-lane conformance |
| **Kinematic** | SOG / COG / ROT anomalies | Wijaya-style continuous drag score from `cogStdDeg` + `displacementM`; ship-type-scaled speed excess; Wijaya `F_{c,h,d}` loitering score — replaces every 2 h / 40° / 150 m step function |
| **Contextual** | vessel-type × area × time-of-day appropriateness | Hand rules v1 (tanker in cable corridor + slow → high; cargo transiting at 10 kn → nominal). Table becomes learnable from Phase 0 labels in a follow-up |
| **Complex / Interaction** | Co-occurring signals in a rolling window | Combos over the `cs.recent` buffer: `(gap ∧ reposition ∧ in_corridor)`, `(loiter ∧ identity_change)`, `(drag ∧ speed_anomaly)`. Encounter / STS deferred |
| **Identity** | C4ADS 3-facet consistency | *Registered* (broadened MID / callsign coverage), *Digital* (`identity_change`, teleport, MMSI-not-in-static), *Physical* (scaffold only, null v1) — score = misalignment across present facets + shell-identity flag |

Interface each sub-model implements (same shape a Bayesian posterior later consumes as an evidence node):

```ts
interface MechanismSubModel {
  readonly axis: MechanismAxis;               // 'positional' | 'kinematic' | 'contextual' | 'complex' | 'identity'
  score(ctx: SubModelContext): {
    score: number;                            // continuous [0, 1]
    evidence: EvidenceBag;                    // structured; feeds dossier
    contributingEventIds: string[];           // for delta analysis vs current fusion
  };
}
```

Per-axis exponential decay stays with a 24 h half-life, but now **per axis in `config.ts`** — not per category — so a future per-axis calibration lands in one place. Every `MechanismScore` is timestamped so a DBN temporal-smoothing swap later is a fuser-level change, not a sub-model change.

### 4b. Framing layer — mechanism → intent projection

Intent set = 3: `cable_interference`, `dark_activity`, `identity_deception`.

v1 projection = weighted sum per (intent, mechanism) then Platt sigmoid:

```
intentRaw[c] = Σ_m W[c][m] · mechScore[m]                    // W is a 3×5 config table
P[c]         = 1 / (1 + exp(A[c] · intentRaw[c] + B[c]))     // Platt sigmoid, per intent
```

`W` is a hand-set 3×5 config table (`config.ts`); starting values derived from current `CLASS_WEIGHT` scaling and documented in a comment. `(A[c], B[c])` are fit by `scripts/fit-platt.ts` on Phase 0 labels; results written to `config.ts` or a KV entry.

If fitting fails the imbalance guard (§3d), Platt is bypassed and `P[c] = clamp(intentRaw[c], 0, 1)` with a `calibrationState: 'uncalibrated'` flag on the output.

**Why this is the Bayesian seam.** Mechanism sub-models are exactly the evidence nodes of a Lane-2010-style network. The v1 weighted-sum + Platt projection is one strategy for computing `P(intent | evidence)`; a Bayesian posterior is another. Swapping strategies is a fuser-level change — mechanism sub-models, decay, and evidence bags stay put.

```ts
interface IntentFuser {
  fuse(mechScores: Record<MechanismAxis, MechanismScore>): Record<IntentCategory, IntentPosterior>;
}
// v1: WeightedSumPlattFuser
// v2: BayesianPosteriorFuser
```

### 4c. Assessment lifecycle — probability bands

Replaces `openScore=0.6 / closeScore=0.2 / dwell=12 h` with per-intent probability bands:

| State | Threshold |
|---|---|
| `none` | `P < 0.15` |
| `watch` | `0.15 ≤ P < 0.4` |
| `elevated` | `0.4 ≤ P < 0.7` |
| `high` | `P ≥ 0.7` |

Downgrade requires sustained lower band for a per-intent dwell (default 12 h, config; bands and `P[c]` are per intent category, so the dwell is per intent — not per mechanism axis). Band boundaries are configurable and will be re-fit against Phase 0 labels for max F1. Sanity check: cutoffs on the three `replay-fusion` scenarios must not regress the assessments the current model gets right.

### 4d. Output & UI

```ts
interface VesselAssessment {
  vesselId: string;
  intents: Record<IntentCategory, {
    P: number;                                        // calibrated [0, 1]
    state: 'none' | 'watch' | 'elevated' | 'high';
    topContributingAxes: [MechanismAxis, number][];   // sorted desc, top 3
    calibrationState: 'calibrated' | 'uncalibrated';
  }>;
  mechanisms: Record<MechanismAxis, {
    score: number;
    lastUpdated: number;
    evidence: EvidenceBag;
  }>;
  topIntent: IntentCategory | null;                   // highest P above 'watch', for halo
}
```

- **Halo colour / trajectory / list ordering** — driven by `topIntent`; drop-in for today's `topCategory`.
- **Dossier** — progressive disclosure (Springer & Whittaker 2020): coarse label + one-line summary at top, expandable "why" showing per-intent probability bars and top mechanism contributions.
- Wire format: `AssessmentSummary` gains `intents` and `mechanisms` maps; legacy `topCategory` stays as a mirror of `topIntent` for one release; legacy `score = maxConfidence*5` on `/api/snapshot` is **removed** and `vessel.score` in D1 is **retired from the read path** (write-only for one release, physical column drop in a follow-up migration — see §5d).
- `AnomalyEvent.severity 1–5` is retained as a UI-only event-feed CSS hint (it never fed scoring); documented as such.

### 4e. Post-ship evaluation artifact

Every candidate incident's `model_snapshot` was frozen at Phase 0 materialization. After Phase 1 ships, per-incident deltas (old fusion output vs new intent probabilities vs human label) give: reliability diagrams per intent, Brier score, ECE, per-mechanism ablation. Written to `docs/threat-model-v1-eval.md` at ship time.

## 5. Implementation surface

### 5a. Files touched / added

| Area | Files touched | New files |
|---|---|---|
| **Phase 0 — Labeling** | `migrations/` (new SQL for `candidate_incidents`, `labels`) · `src/worker.ts` (new `/api/labels/*` routes) · `web/src/panels.ts`, `web/src/map.ts`, `web/src/main.ts` (Review mode) · `src/types.ts` (label + candidate types) · retire `militia_presence` from `src/types.ts:43`, `web/src/vessels.ts` `CAT_MATCH`, related tests | `scripts/materialize-candidates.ts` · `web/src/review.ts` (Review-mode UI) · `data/curated-incidents.json` |
| **Phase 1 — Fuser** | `src/fusion.ts` (rewrite around mechanism sub-models + fuser strategy) · `src/config.ts` (per-axis half-lives, `W[c][m]` weight table, Platt params, state-band cutoffs) · `src/db.ts` (stop reading `vessel.score`, `score_ts` in the query paths; writes retained for one release per §5d) · `src/worker.ts` (`/api/snapshot`, `/api/vessel`, `/api/trajectories` return new shape) · `web/src/vessels.ts`, `web/src/trajectories.ts`, `web/src/dossier.ts` (read `intents` / `mechanisms`) | `src/mechanisms/positional.ts` · `src/mechanisms/kinematic.ts` · `src/mechanisms/contextual.ts` · `src/mechanisms/complex.ts` · `src/mechanisms/identity.ts` · `src/fusers/weightedSumPlatt.ts` · `src/fusers/index.ts` (strategy dispatch) · `scripts/fit-platt.ts` |
| **Detectors** | `src/detectors/*` — **unchanged behaviorally**; each keeps emitting `AnomalyEvent`s. What changes is downstream (`fusion.ts` consumes numeric evidence, not just event type + class). Cooldowns stay per the current values in `config.ts` | — |

### 5b. Ship order (three PRs)

1. **PR-A: labeling harness only.** Migrations, materializer, `/api/labels/*`, Review-mode UI. **No change to `fusion.ts` or scoring.** Old formula continues to drive the map. Ships in isolation — merge as soon as it's usable so labeling accumulates while Phase 1 is in review.
2. **PR-B: mechanism sub-models + `WeightedSumPlattFuser`, gated behind a feature flag.** New API shape available on `/api/snapshot?model=v2`. Old model still default. `scripts/fit-platt.ts` runs against accumulated labels. Web UI reads whichever flag is set. This is the risky change; it lives behind the flag until (a) Phase 0 hits its label targets, (b) reliability diagram + Brier are within a defined band on the eval split, (c) the operator has eyeballed a set of top-differing incidents.
3. **PR-C: cutover.** Flag flips to `v2` as default; old fusion code deleted; `/api/snapshot` legacy `score = maxConfidence*5` compat field removed; `vessel.score` and `score_ts` are no longer read (writes continue one release per §5d, physical column drop in a follow-up migration); API version bumps. Gated on Phase 0 label targets met AND PR-B eval passed AND `docs/threat-model-v1-eval.md` written.

### 5c. Test-suite migration

| Test file | Current role | Action |
|---|---|---|
| `test/fusion.test.ts` | Asserts exact 0.45 / 0.9 / 0.375 from `CLASS_WEIGHT` table | **Rewrite** against mechanism sub-models. Each mechanism gets its own unit test with a small fixture. Fusion test asserts a known evidence set produces `intentRaw[c]` in a documented range. |
| `test/fusion-lifecycle.test.ts` | Asserts open @ 0.6 / close @ 0.2 / 12 h dwell | **Rewrite** against the 4-band state machine. Same replay style, new expected states. |
| `test/replay-fusion.test.ts` | 3 named scenarios (regression) | **Extend, don't rewrite.** Each scenario gains an expected `intents` + `mechanisms` snapshot recorded at the moment of cutover. These become v1 regression ground truth. Scenarios that reveal old-model false positives (e.g. coverage-edge silence) become *asserted-benign* under v2. |
| `test/*` (other) | Detectors, utils | **Unchanged.** Detectors don't change behavior. |

### 5d. Backward-compat & migration

- `AssessmentSummary` gains `intents` and `mechanisms` maps additively for one release; `topCategory` is populated from `topIntent` throughout the transition.
- `vessel.score` column: **not** dropped in PR-C — set nullable + write-only (never read) for one release, then removed in a follow-up migration.
- API versioning: `/api/snapshot` accepts `?model=v1|v2` starting PR-B; `?model=v2` becomes default in PR-C; `?model=v1` removed one release later.
- DO restart still loses pre-`watch` mechanism scores (same fail-conservative behaviour as today). Persisting per-mechanism state on every AIS message is write-amplification we shouldn't take on for v1. Documented in `docs/threat-model-v1.md`.

## 6. Success criteria for the cutover gate

All must hold before PR-C ships:

- Phase 0 label targets met: ≥ 200 total, ≥ 40 threat, ≥ 100 benign, imbalance ≤ 1:5.
- On the held-out eval split (per-vessel): Brier score improved vs v1; ECE ≤ 0.10 on any intent with ≥ 20 eval instances.
- Zero regression on the three named `replay-fusion` scenarios that today's model gets right.
- ≥ 2 previously-false-positive scenarios (documented) are asserted-benign under v2.
- Manual eyeball of top-30 incidents where v1 and v2 disagree most — no obvious v2 regressions.

## 7. Risks & mitigations

- **Labels never accumulate to threshold.** Phase 1 sits behind the flag indefinitely. Mitigation: PR-C is gated, not scheduled. Phase 0 UI ships value on its own (better incident-review context in the map).
- **Class imbalance sabotages Platt.** Guarded (§3d — refuses to fit worse than 1:5). Fallback: `calibrationState: 'uncalibrated'` flag + raw clamped `intentRaw`.
- **v2 disagrees with operator intuition on a known-good vessel.** Explicit eyeball gate before PR-C. Rollback = flip the flag back to `v1`; no schema loss because both models produce the same wire format.
- **Sub-model interface constrains a Bayesian pivot we haven't validated.** The interface returns `{ score, evidence, contributingEventIds }` — the same three a BN evidence node needs (evidence for CPT lookup, event IDs for provenance, score for hybrid setups). Reviewed against Lane 2010's structure — clean.
- **The 24 h uniform per-axis half-life is still wrong.** Explicitly deferred. Follow-up: fit per-axis half-lives against labels once we have enough temporal coverage in the label set.

## 8. Open items to resolve when writing the implementation plan

Not blocking approval; resolved during plan authoring:

- Exact `W[c][m]` starting weights — placeholder derived from current `CLASS_WEIGHT` scaling.
- State-band cutoffs `0.15 / 0.4 / 0.7` — sanity-check against current open / close behaviour on the three replay scenarios.
- MID / callsign lookup expansion source — likely ITU MARS or a public MID list.
- Exact H3 resolution for random-negative sampling (candidate: none; sample per-vessel not per-cell; skipping H3 v1).

## 9. Verified literature (adversarially filtered)

Cited across §1.1 and the individual mechanism sub-models. Full list, one line each:

- Lane, Nevell, Hayward, Beaney 2010 — *Maritime anomaly detection and threat assessment* (QinetiQ; FUSION 2010) — Bayesian network fusion of 5 sub-scores.
- Riveiro, Pallotta, Vespe 2018 — *Maritime anomaly detection: A review* (WIREs Data Min. Knowl. Discov.) — 5-way taxonomy (positional / contextual / kinematic / complex / data-related).
- Pallotta, Vespe, Bryan 2013 — *Vessel Pattern Knowledge Discovery from AIS Data* (Entropy 15(6):2218) — TREAD route-model + Mahalanobis deviation.
- Global Fishing Watch 2024 — *IUU fishing insights framework* — 11 indicators in 3 families.
- Nascimento et al. 2024 — *Hybrid Framework for Maritime Surveillance* (Sensors) — 5-module JDL stack + active learning.
- Hwang et al. 2026 — arXiv 2606.29721 — Equation-grounded A1 / A2 / A3 anomaly triggers.
- Park (Hyobin) et al. 2025 — arXiv 2508.07668 (AIS-LLM) — CRI head over DCPA / TCPA / bearing / speed ratio.
- Lloyd's List Intelligence — Seasearcher ARC — 4-layer illicit voyage.
- Park (Sanghyeon), Cho, Son 2026 — arXiv 2603.11055 — three-tier hygiene → IMM → DBSCAN.
- Wijaya & Nakamura 2023 — Loitering `F_{c,h,d}` closed-form score.
- Welch et al. 2022 — *Hot spots of unseen fishing vessels* (Sci. Adv.) — BRT on gap features.
- C4ADS 2021 — *Unmasked: Vessel Identity Laundering* — registered / digital / physical 3-facet.
- Wang et al. 2019 — J. Phys. Conf. Ser. 1302 042023 — DBN with EM for target threat assessment.
- Yan, Wang et al. 2023 — JMSE 11(8):1596 — Fuzzy DS with belief-divergence weighting.
- Niculescu-Mizil & Caruana 2005 — ICML — Platt scaling & isotonic calibration.
- Liebhaber & Smith 2000 — SPAWAR ADA457915 — 22-factor operator feature vector.
- Nguyen et al. 2019 — arXiv 1912.00682 — GeoTrackNet (VRNN + a contrario).
- Laxar et al. 2023 — BMC Medicine — CDSS trust vs weight-on-advice.
- Karvetski & Mandel 2020 — Risk Analysis 40(5):1040 — coherentization + aggregation beats ACH.
- Springer & Whittaker 2020 — ACM TiiS 10(4) — progressive disclosure.

20 additional citations were dropped after adversarial fact-checking (misattributed authors, wrong year, or the granularity idea was not actually present in the source).
