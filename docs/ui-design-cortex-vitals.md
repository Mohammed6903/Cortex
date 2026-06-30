# Cortex UI — "Cortex Vitals" design & build plan

> Selected via a multi-agent design workflow (explorers → researchers → thinkers →
> advocate/skeptic debate → synthesis). Won on a combined score of **81** (lifecycle 92,
> impressiveness 85, novelty 84, usability 70, feasibility 74). The debate's findings about
> the engine's *real* event grammar and the `@lru_cache` singleton are baked into this plan.

## Concept

**Cortex Vitals — a vitals monitor for a machine mind.** The UI *is the mechanism, not a
metaphor for it.* Every meter, threshold, and curve is wired to a real field the API returns;
the user physically drives the memory lifecycle (form → reinforce → branch → demote → archive
→ prune) and watches deterministic consequences. Grafana-grade observability up top, a
forensic git-style timeline inspector underneath.

### Signature interaction — "warm-up on retrieve" (`touch()` made physical)
From the command palette run `retrieve "coffee"` (or click a cooling belief's retrieve
affordance). The instant `/retrieve` returns: the belief pulses signal-cyan, its row slides
**up** from the dormant (amber) lane into the active (cyan) lane, its dot in the Retention
Histogram jumps right of the `0.35` cliff, and a green `↑retrieve` annotation drops onto the
forgetting curve — all real effects of `touch()` resetting `last_accessed_at` and promoting
`dormant → active`. Then stop querying it and drag the time scrubber forward: the same belief
cools, drifts back across `0.35` into dormant, `0.15` into archived, and — if `salience ≤ 0.2`
and never accessed — vanishes on the next `maintain`, leaving a tombstone. You operate
"use it or lose it" with your own hands.

## Design language

Grafana-meets-Linear instrument register.

- **Canvas** near-black `#0A0B0D`; 4-step graphite surface scale `#101216 / #16191F / #1D2127 / #262B33`; hairline borders `#2A2F38`.
- **One rationed accent** — signal-cyan `#4ED8C4` — reserved for *active / currently-held / healthy* and the single primary action per screen.
- **Fixed tier ramp** everywhere: active = cyan, dormant = amber `#E0A458`, archived = slate `#5B6470`, pruned = tombstone outline only.
- **Event-verb hues** (muted): formed = cyan, reinforced = green `#5FB87A`, contradicted/superseded = red `#D86A6A`, merged = violet `#9B7FD8`, demoted = amber, promoted = bright cyan.
- **Type grammar:** Inter (300/400, 510 for emphasis) for belief `statement` prose; JetBrains Mono for *all machine truth* — ids, timestamps, confidence/salience/retention floats, event verbs, payloads. `confidence` and `salience` map to **both a number and opacity/weight** (a 0.28 belief literally fades; a 0.91 reads heavy).
- **Motion** (framer-motion, diegetic): retrieve → cyan pulse + histogram dot snaps right; demotion → row slides down a lane with an amber flash; inspector node → drawer unfolds 160ms ease-out. `prefers-reduced-motion` swaps every animation for a labeled before/after.
- **No** gradients, no glowing-brain hairball, no KPI-card-grid cliché.

## Information architecture

| Route | Purpose |
|-------|---------|
| `/` — **Mind Monitor** (hero) | KPI strip · Beliefs-by-Tier ladder · live Retention histogram · Formation/Forgetting curve · Reconciliation event stream — over a server-seeded scratch session |
| `/belief/[id]` — **Belief Inspector** | KPI header (statement, type+tier badges, confidence/salience meters, live estimated retention + distance-to-next-demotion), git-style branching lifecycle timeline from `/beliefs/{id}/timeline`, right pane = "state as of selected event" or before/after diff drawer |
| `/beliefs` — **Belief Ledger** | dense mono table of `/beliefs?all=true`, opacity-weighted by confidence, grouped by tier, client "sort by retention" |
| **Time-Travel Scrubber** (global overlay) | `now`-slider bound to optional `now` on `/learn`, `/maintain`, `/retrieve`; replays `evals/scenarios/*.json` against the scratch db |
| **Command Palette** (⌘K) | keyboard verb-runner mirroring the CLI — ingest / learn / maintain / retrieve / replay / inspect / reset-session / jump-to-belief |
| **Lineage** (gated, secondary) | ego-graph of ONE belief — `superseded_by` chain + merged-from edges only; never a full-brain hairball |

## Key components

`AppShell` · `KpiStrip` · `TierLadder` · `RetentionHistogram` (with 0.15/0.35 cliff markers) ·
`LifecycleCurve` (SVG with event annotations) · `ReconciliationStream` · `BeliefTimeline`
(git gutter, forks at `detail.kind='branch'` and supersede/merge) · `DiffDrawer` ·
`StateAsOfPane` (event-sourcing fold) · `Meter` / `Badge` / `Sparkline` / `Drawer` /
`EmptyState` (hand-rolled, no UI kit) · `CommandPalette` · `lib/api.ts` (typed fetch) ·
`lib/retention.ts` (client port of the formula) · `lib/session.ts` (scratch reset/seed).

## Honesty & safety constraints (from the debate — non-negotiable)

1. **Real event grammar, not fiction.** There is no `branched` event type. A *branch* is a
   `contradicted` event carrying `detail.kind='branch'`; a *supersede* emits **both**
   `contradicted` and `superseded` for one act. The reconciliation stream and timeline must
   read these from real data and **de-dupe supersede to a single row**.
2. **Never mutate the live store.** `get_engine` is a single `@lru_cache(maxsize=1)` bound to
   one db, and `maintain(now)` does irreversible demotions + hard-delete prunes. All
   replay/scrub/maintain runs go against a **server-seeded scratch session**.
3. **The PRUNED tombstone** is reconstructed by snapshot-diffing two `/beliefs?all=true` reads
   across a maintain run (prune emits no event — the only honest way).
4. **Live retention is labeled "estimated"** — client-recomputed from the documented formula
   (`w_sal .5 / w_reinf .3 / w_rec .2`, halflife 14d, cliffs `.35`/`.15`) with the governing
   thresholds shown inline, so the headline metric never silently lies.

## Recommended stack

Next.js (App Router) + React + TypeScript in a **sibling `Cortex/web/`** dir (not inside the
`cortex/` package). Tailwind v3 (matching `fs-ingestion/web/` — not v4). Hand-rolled primitives
only — **no** shadcn/Radix/clsx/tailwind-merge. `lucide-react` icons, `framer-motion` v11.
Typed `lib/api.ts` over raw fetch (`NEXT_PUBLIC_API_BASE ?? http://localhost:8000`). Plain
React state + Context — **no** React Query/Redux/Zustand. **No charting lib** — histogram /
ladder / sparklines / curve are styled divs + a few SVG paths. Scaffold by copying
`fs-ingestion/web/`. Scripts: `dev` / `build` / `lint` / `typecheck` (`tsc --noEmit`).

## Build phases

- **Phase 0 — Scaffold.** Copy `fs-ingestion/web/` → `Cortex/web/`; wire `lib/api.ts` over the
  existing routes; `lib/retention.ts` client port + a vitest checking it against
  `demoted.detail.score` from a real timeline.
- **Phase 1 — Backend safety/honesty routes** (small, additive; follow CLAUDE.md SQL rules):
  `POST /session/reset` (+ scenario seed against a scratch `db_path`), `GET /beliefs/{id}/provenance`
  over `beliefs.provenance()`, optional `GET /stats` + `GET /config` (so thresholds aren't
  hardcoded). All idempotent / non-destructive.
- **Phase 2 — Belief Inspector** (`/belief/[id]`): KPI header, git-style branching timeline,
  `StateAsOfPane`, `DiffDrawer`, inline provenance episodes; honest empty/loading/error states
  for formed-only and pruned beliefs.
- **Phase 3 — Mind Monitor** (`/`): `KpiStrip`, `TierLadder`, `RetentionHistogram`,
  `LifecycleCurve` with annotations, `ReconciliationStream` stitched from POST responses + timelines.
- **Phase 4 — Time-Travel + Command Palette**: `now`-scrubber driving `/learn` `/maintain`
  `/retrieve` against the scratch db; replay `evals/scenarios/*.json`; ⌘K verbs incl.
  reset-session; the warm-up-on-retrieve interaction end-to-end.
- **Phase 5 — Polish**: framer-motion pulse/slide/snap + reduced-motion fallbacks; PRUNED
  tombstone via snapshot-diff; Belief Ledger virtualization stub; ESLint + `tsc --noEmit` clean.

## Mockup — Mind Monitor (hero)

```
┌─ CORTEX · MIND MONITOR ───────────────────  ⌘K  ·  scratch·02_branch  ·  now ▸ 2026-06-24 09:14 UTC ─┐
│ HELD 14   DORMANT 6   ARCHIVED 3   PRUNED 2↓   │  last learn +1 branched · last maintain 1 demoted 1 pruned│
├───────────────────────────────────────────────┼──────────────────────────────────────────────────────────┤
│ BELIEFS BY TIER                     [all ▾]    │ RECONCILIATION STREAM             ⟲ live · scratch session  │
│                                                │                                                            │
│ ACTIVE ▸ 14 ████████████████░░░░  cyan         │ 09:14 ⎇ contradicted "Prefers coffee"  kind=branch ← tea    │
│   ● Prefers coffee        c0.80 s0.60  ↑3      │       old → dormant · validity closed · superseded_by set  │
│   ● Lives in Pune         c0.90 s0.60  ·       │ 08:51 ⊝ superseded   "Lives in Pune"   ← Mumbai            │
│   ● Wants to learn cello  c0.66 s0.72  ↑1      │       old → archived · superseded_by → bel_a91c           │
│   ○ Weather was rainy     c0.50 s0.10  used    │       (contradicted+superseded de-duped to one row)        │
│ DORMANT ▸ 6  ██████░░░░░░░░░░░░  amber          │ 08:40 ⤴ reinforced   "Wants to learn cello"               │
│   ◐ Prefers tea           c0.70 s0.50  ~0.31e  │       confidence 0.58 → 0.66  (+0.08)                      │
│   ◐ Standup at 9am        c0.60 s0.40  ~0.29e  │ 07:22 ✦ formed       "Drinks oat milk"  c0.55             │
│ ARCHIVED ▸ 3  ███░░░░░░░░░░░░░░  slate          │ ── maintain 06:00 ───────────────────────────────────────  │
│   ⊗ Lives in Mumbai       c0.80 s0.60  →Pune   │ 06:00 ▽ demoted      "Standup at 9am"  active→dormant       │
│   ⊗ Office coffee empty   c0.50 s0.10  prune?  │       retention 0.29  (< 0.35 active floor)                │
│   ⊗ Old gym location      c0.40 s0.15  prune?  │ 06:00 ⌦ pruned       "Old gym is closed"  (tombstone·diff) │
├───────────────────────────────────────────────┼──────────────────────────────────────────────────────────┤
│ RETENTION SCORE DISTRIBUTION (est·client)      │ FORMATION ▲ / FORGETTING ▼  · 24w · halflife 14d           │
│  n          w·sal.5 reinf.3 rec.2  hl14d       │ held                                                       │
│ 6│            ▆▆ ▆▆                             │  16┤            ╭──●reinforce   ·tea│coffee branch          │
│ 4│        ▄▄ ▆▆ ▆▆ ██                           │  12┤        ╭───╯           ╰─╮   ╭── retrieve↑warm         │
│ 2│  ▂▂ ▂▂ ▆▆ ▆▆ ██ ██ ██ ▄▄                     │   8┤    ╭───╯  Pune supersede ╰───╯                          │
│ 0└──┴──┴──┴──┴──┴──┴──┴──┴──→ score             │   4┤ ╭──╯  ▽demote    ▽▽   ⌦prune                           │
│   .10 .15 .25 .35 .45 .55 .70 .85              │   0┼──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──→ wk               │
│   ↑archive  ↑dormant cutoff · ● = selected     │     Jan      Mar      May       now▸ Jun                   │
├──────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ ◀━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━●  TIME-TRAVEL ▸ replay 02_contradiction_branch  · scratch only   │
│   Jan10 tea formed  ···  Jun20 coffee branch  ···  now   [⏵ play]  drag → drives /learn now=…  [↺ reset]    │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
   legend  cyan=active amber=dormant slate=archived · opacity=confidence · mono=machine-truth sans=belief · e=estimated
```

## Mockup — Belief Inspector

```
┌─ CORTEX · BELIEF INSPECTOR ───────────────────────────  ⌘K  ·  inspect bel_a3f1c9  ·  scratch·02_branch ─┐
│  ⌘K  inspect  learn  maintain  retrieve  replay  reset           now ▸ 2026-06-20 09:00 UTC   [Ledger ▸] │
├────────────────────────────────────────────┬──────────────────────────────────────────────────────────┤
│ BELIEF                                       │ STATE AS OF SELECTED EVENT          [◀ diff ▶]            │
│ Prefers coffee                      (sans)   │ ┌────────────────────────────────────────────────────┐  │
│ ──────────────────────────────────────────  │ │ tier         active        ● held                   │  │
│ bel_a3f1c9  ·  preference                    │ │ confidence   0.88  ████████░   (+0.08 from 0.80)    │  │
│ ● active · currently held                    │ │ salience     0.60  ██████░░░                        │  │
│ confidence 0.88 ████████░  (heavy)           │ │ reinf_count  1                                      │  │
│ salience   0.60 ██████░░░                     │ │ validity     2026-06-20 → (open)                    │  │
│ retention  ~0.71 e  · next demote ~38d        │ │ last_access  never                                  │  │
│   if never accessed (client est, w .5/.3/.2) │ │ supersedes   bel_77b0e2 (Prefers tea)               │  │
│ provenance ▸ ep_4c2a  notes/entry            │ └────────────────────────────────────────────────────┘  │
├────────────────────────────────────────────┴──────────────────────────────────────────────────────────┤
│ LIFECYCLE TIMELINE                                                          GET /beliefs/{id}/timeline   │
│                                                                                                          │
│  ◇ formed         2026-06-20 08:00   "Prefers coffee"   conf 0.80    (cyan)                              │
│  │   ▸ episode  ep_4c2a  notes/entry   /beliefs/{id}/provenance                                          │
│  │     "switched to coffee, tea just isn't doing it anymore"   occurred 08:00 · ingested 08:59           │
│  ◆ reinforced     2026-06-20 08:00   conf 0.80 → 0.88   ▲ +0.08    (green)                               │
│  ├─◀ contradicted 2026-06-20 08:00   by bel_77b0e2   detail.kind=branch   (red)   [open diff ▸]          │
│  │ \                 preference change — old belief DEMOTED to dormant, kept as history                  │
│  │  \ ◇ formed      2026-01-10 08:00   "Prefers tea"    conf 0.70   ░dim (the forked lane)               │
│  │   \│   ▸ episode  ep_91bd  "had a lovely cup of tea this morning"                                     │
│  │    │ ◣ demoted    2026-06-20 08:00   active → dormant   score 0.33   ░dim   (amber)                   │
│  │    │    validity closed 2026-06-20 · NOT archived (branch≠supersede)                                  │
│  ◎ now ─────────── 2026-06-20 09:00   ◀ time cursor (drag to scrub state · runs against scratch db)      │
│                                                                                                          │
│  ── DIFF (contradicted) ────────────────────────────────────────────────────────────────────────────   │
│   before  "Prefers tea"     conf 0.70  validity 2026-01-10 → open                                        │
│   after   "Prefers coffee"  conf 0.80  validity 2026-06-20 → open   reason: preference evolved (branch)  │
│  filters: [✓ active] [✓ dormant] [ archived] [ pruned ✗ no-event · tombstone via snapshot-diff only ]    │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Alternatives considered (not selected)

- **Cortex Inspector — "git log for a mind"** (71): the single-belief forensic timeline as the
  literal hero. Highest thesis-to-data fidelity, but narrower and needs a client-side join for
  forked history. *Its git-gutter + diff drawer were grafted into Vitals' inspector.*
- **Cortex Journal** (68): editorial "what I know about you" where typography encodes the data
  (weight=confidence, opacity=recency, rule=validity). Highest design ceiling / most humane, but
  showcases the lifecycle least directly and needs numeric crutches for accessibility.
- **Confluence / Stream** (61) and **Skymap / Constellation** (58): rejected — the stream's
  deterministic replay only works via the CLI's scripted-LLM path (HTTP `/learn` with mock 500s),
  and the constellation has no data at the scale a node-link map needs (scenarios yield 1–2 beliefs).
