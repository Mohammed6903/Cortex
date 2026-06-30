"use client";

/**
 * Mind Monitor (hero) — `/`
 *
 * Assembles the five Phase-3 leaf components into the layout of the doc's "Mind Monitor"
 * mockup, over a server-seeded SCRATCH session:
 *
 *   ┌ KpiStrip (held/dormant/archived/pruned + last learn/maintain deltas) ───────────────┐
 *   ├ TierLadder (BELIEFS BY TIER) ───────────────┬ ReconciliationStream (verb-led feed) ──┤
 *   ├ RetentionHistogram (est·client) ────────────┼ LifecycleCurve (FORMATION ▲ / FORGET ▼)┤
 *   ├ Time-Travel scrubber slot (reserved — built in Phase 4) ────────────────────────────┤
 *   └──────────────────────────────────────────────────────────────────────────────────────┘
 *
 * This integrator owns the shared state the leaves coordinate on:
 *   - the boot sequence: POST /session/reset → GET /beliefs?all=true + /stats + /config
 *   - `selectedId`, lifted across TierLadder ↔ RetentionHistogram ↔ LifecycleCurve
 *   - the `now` time-cursor + scenario, mirrored into SessionContext for the chrome
 *   - the run log (POST /learn + /maintain responses) the ReconciliationStream replays,
 *     and the across-maintain snapshot-diff that reconstructs PRUNED tombstones
 *   - the population time-series + event annotations bucketed for the LifecycleCurve
 *
 * Honesty constraints upheld at this layer:
 *   - We never mutate the live store — every read/run is against the scratch session the
 *     backend seeds. (No learn/maintain is issued on load; those land in Phase 4.)
 *   - PRUNED is reconstructed ONLY by snapshot-diffing two /beliefs?all=true reads across a
 *     maintain (lib/events.diffPruned); on first load there is no diff, so prunedCount = 0.
 *   - There is no `branched` event type; the curve annotations carry kind="branch" for a
 *     contradicted+detail.kind="branch", and supersede pairs are collapsed before painting.
 *   - Retention here is the CLIENT estimate (lib/retention), fed by GET /config so it tracks
 *     the engine, and is labeled "est" by the components that show it.
 */

import * as React from "react";
import { AlertTriangle, Loader2 } from "lucide-react";

import {
  api,
  ApiError,
  type Belief,
  type BeliefEvent,
  type ConfigResponse,
  type LearnResult,
  type MaintainResponse,
  type StatsResponse,
} from "@/lib/api";
import {
  weightsFromConfig,
  thresholdsFromConfig,
  type RetentionThresholds,
  type RetentionWeights,
} from "@/lib/retention";
import { collapseSupersede, diffPruned, isBranch, type EventKind } from "@/lib/events";
import { nowIso } from "@/lib/session";
import { EmptyState, Mono } from "@/components/primitives";
import { useSession } from "@/components/SessionContext";
import { TimeTravelScrubber } from "@/components/TimeTravelScrubber";
import {
  CommandPalette,
  type PaletteIntent,
} from "@/components/CommandPalette";

import { KpiStrip, type LearnDelta } from "@/components/monitor/KpiStrip";
import { TierLadder } from "@/components/monitor/TierLadder";
import { RetentionHistogram } from "@/components/monitor/RetentionHistogram";
import {
  LifecycleCurve,
  type LifecycleAnnotation,
  type LifecyclePoint,
} from "@/components/monitor/LifecycleCurve";
import {
  ReconciliationStream,
  type StreamRun,
} from "@/components/monitor/ReconciliationStream";

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

/** The scenario seeded on first load — a branch/supersede story so the API is never empty. */
const DEFAULT_SCENARIO = "02_contradiction_branch";

// ---------------------------------------------------------------------------
// load state
// ---------------------------------------------------------------------------

interface MonitorData {
  beliefs: Belief[]; // GET /beliefs?all=true
  stats: StatsResponse | null;
  config: ConfigResponse | null;
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string; status_code: number }
  | { status: "ready"; data: MonitorData };

// ---------------------------------------------------------------------------
// curve bucketing — population time-series + event annotations from a snapshot
// ---------------------------------------------------------------------------

/** Parse an ISO instant to epoch ms, or null if absent / unparseable. */
function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * Reconstruct a "held (active) count over time" series from a beliefs snapshot. The engine
 * gives us no historical population samples, so we build a step series from each belief's
 * validity window: +1 at validity_start, -1 at validity_end (when closed). This is a real
 * population count derived from real fields (NOT an estimate) — exactly what LifecycleCurve
 * wants for its `points`.
 */
function buildPoints(beliefs: Belief[], nowMs: number): LifecyclePoint[] {
  type Delta = { t: number; d: number };
  const deltas: Delta[] = [];
  for (const b of beliefs) {
    // only beliefs currently held (active) contribute to the "held" line; a belief that
    // has been demoted/archived/closed leaves the active population at its validity_end.
    const start = ms(b.validity_start) ?? ms(b.created_at);
    if (start == null) continue;
    deltas.push({ t: start, d: +1 });
    const end = ms(b.validity_end);
    if (end != null) deltas.push({ t: end, d: -1 });
    else if (b.tier !== "active") {
      // open-validity belief that is no longer active (demoted on recency): it left the
      // held population at updated_at (best available instant for the transition).
      const left = ms(b.updated_at);
      if (left != null && left > start) deltas.push({ t: left, d: -1 });
    }
  }
  if (deltas.length === 0) return [];
  deltas.sort((a, b) => a.t - b.t);

  const points: LifecyclePoint[] = [];
  let held = 0;
  for (let i = 0; i < deltas.length; i++) {
    held += deltas[i].d;
    // collapse same-instant deltas into a single sample
    if (i + 1 < deltas.length && deltas[i + 1].t === deltas[i].t) continue;
    points.push({ t: deltas[i].t, held: Math.max(0, held) });
  }
  // anchor the final sample at `now` so the curve runs up to the cursor
  const last = points[points.length - 1];
  if (last && last.t < nowMs) points.push({ t: nowMs, held: last.held });
  return points;
}

/**
 * Best-effort event annotations from per-belief timelines. On the hero we have the snapshot
 * (formation instants) for free; richer timelines are fetched lazily for the few beliefs
 * that have lifecycle interest (superseded / demoted / branched). Honesty: supersede pairs
 * are collapsed and branches are surfaced as kind="branch" (never a fictional "branched").
 */
function annotationsFromTimelines(
  timelines: Record<string, BeliefEvent[]>,
  beliefs: Record<string, Belief>,
): LifecycleAnnotation[] {
  const out: LifecycleAnnotation[] = [];
  for (const [beliefId, raw] of Object.entries(timelines)) {
    const collapsed = collapseSupersede(
      raw.map((e) => ({ ...e, detail: { ...e.detail } })),
    );
    for (const e of collapsed) {
      const t = ms(e.at);
      if (t == null) continue;
      const kind: EventKind = isBranch(e)
        ? "branch"
        : (e.event_type as EventKind);
      const stmt = beliefs[beliefId]?.statement;
      out.push({
        id: e.id != null ? `${beliefId}:${e.id}` : `${beliefId}:${e.event_type}:${e.at}`,
        t,
        kind,
        label: stmt,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// page
// ---------------------------------------------------------------------------

export default function MonitorPage() {
  const session = useSession();
  const { now, setScenario } = session;

  const [state, setState] = React.useState<LoadState>({ status: "loading" });
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  // per-belief timelines, fetched lazily to enrich the curve + stream (best-effort).
  const [timelines, setTimelines] = React.useState<Record<string, BeliefEvent[]>>(
    {},
  );

  // the run log the ReconciliationStream replays + the deltas the KpiStrip shows.
  // Empty on first load (no learn/maintain issued on boot — the page is a pure read).
  // Phase 4's palette/scrubber append here after every verb.
  const [runs, setRuns] = React.useState<StreamRun[]>([]);
  const [lastLearn, setLastLearn] = React.useState<LearnDelta | null>(null);
  const [lastMaintain, setLastMaintain] = React.useState<MaintainResponse | null>(null);
  // PRUNED tombstones reconstructed via snapshot-diff across a maintain (0 until one runs).
  const [prunedCount, setPrunedCount] = React.useState(0);

  // transient: the just-warmed belief id for the signature retrieve interaction. TierLadder
  // consumes it as `pulseId` to flash + slide the row from dormant → active.
  const [pulseId, setPulseId] = React.useState<string | null>(null);
  const pulseTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // transient: belief ids that just DEMOTED on the last maintain. TierLadder flashes them
  // amber as they slide down a lane (reduced-motion swaps the flash for a ▽demoted tag).
  const [flashDemotedIds, setFlashDemotedIds] = React.useState<Set<string>>(
    () => new Set(),
  );
  const demoteTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- boot: reset scratch session, then read beliefs + stats + config ----
  React.useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });

    async function boot() {
      try {
        const reset = await api.resetSession(DEFAULT_SCENARIO);
        if (cancelled) return;
        if (reset.ok) {
          setScenario(DEFAULT_SCENARIO, true);
        }
      } catch (e) {
        if (cancelled) return;
        setState({
          status: "error",
          message:
            e instanceof Error
              ? `session reset failed: ${e.message}`
              : String(e),
          status_code: e instanceof ApiError ? e.status : 0,
        });
        return;
      }

      // beliefs is required; stats + config degrade gracefully.
      let beliefs: Belief[];
      try {
        beliefs = await api.beliefs(true);
      } catch (e) {
        if (cancelled) return;
        setState({
          status: "error",
          message: e instanceof Error ? e.message : String(e),
          status_code: e instanceof ApiError ? e.status : 0,
        });
        return;
      }

      const [stats, config] = await Promise.all([
        api.stats().catch(() => null),
        api.config().catch(() => null),
      ]);
      if (cancelled) return;
      setState({ status: "ready", data: { beliefs, stats, config } });
    }

    void boot();
    return () => {
      cancelled = true;
    };
  }, [setScenario]);

  // ---- lazily fetch timelines for beliefs with lifecycle interest (curve/stream) ----
  React.useEffect(() => {
    if (state.status !== "ready") return;
    let cancelled = false;
    // pull timelines for every belief in the (small) scratch scenario; best-effort.
    const ids = state.data.beliefs.map((b) => b.id);
    Promise.all(
      ids.map((id) =>
        api
          .timeline(id)
          .then((evs) => [id, evs] as const)
          .catch(() => [id, [] as BeliefEvent[]] as const),
      ),
    ).then((pairs) => {
      if (cancelled) return;
      const map: Record<string, BeliefEvent[]> = {};
      for (const [id, evs] of pairs) map[id] = evs;
      setTimelines(map);
    });
    return () => {
      cancelled = true;
    };
  }, [state]);

  // engine-truth retention config (falls back to documented defaults).
  const config = state.status === "ready" ? state.data.config : null;
  const weights = React.useMemo<RetentionWeights>(
    () => weightsFromConfig(config),
    [config],
  );
  const thresholds = React.useMemo<RetentionThresholds>(
    () => thresholdsFromConfig(config),
    [config],
  );

  const nowMs = now.getTime();

  const beliefs = React.useMemo<Belief[]>(
    () => (state.status === "ready" ? state.data.beliefs : []),
    [state],
  );

  // id→Belief lookup for the stream's statement enrichment.
  const beliefsById = React.useMemo(() => {
    const map: Record<string, Belief> = {};
    for (const b of beliefs) map[b.id] = b;
    return map;
  }, [beliefs]);

  // curve geometry: population step-series + collapsed event annotations.
  const points = React.useMemo(
    () => buildPoints(beliefs, nowMs),
    [beliefs, nowMs],
  );
  const annotations = React.useMemo(
    () => annotationsFromTimelines(timelines, beliefsById),
    [timelines, beliefsById],
  );

  // ---- refetch: re-read beliefs + stats + config into ready state (post-verb) ----
  const refresh = React.useCallback(async (): Promise<Belief[]> => {
    const beliefsAll = await api.beliefs(true);
    const [stats, config] = await Promise.all([
      api.stats().catch(() => null),
      api.config().catch(() => null),
    ]);
    setState({ status: "ready", data: { beliefs: beliefsAll, stats, config } });
    return beliefsAll;
  }, []);

  // ---- verb handlers — all against the SCRATCH session; refresh data after each ----

  /** Re-seed the scratch db from a scenario (or empty), then reset all derived state. */
  const handleResetSession = React.useCallback(
    async (scenario?: string) => {
      setState({ status: "loading" });
      const reset = await api.resetSession(scenario);
      setScenario(scenario ?? null, reset.ok);
      setRuns([]);
      setLastLearn(null);
      setLastMaintain(null);
      setPrunedCount(0);
      setSelectedId(null);
      setTimelines({});
      setPulseId(null);
      setFlashDemotedIds(new Set());
      await refresh();
    },
    [refresh, setScenario],
  );

  /** POST /learn now=… → append a learn run, count the action deltas, refresh. */
  const handleLearn = React.useCallback(
    async (iso?: string) => {
      const res = await api.learn(iso);
      const delta: LearnDelta = {};
      for (const r of res.results) {
        delta[r.action] = (delta[r.action] ?? 0) + 1;
      }
      setLastLearn(delta);
      setRuns((prev) => [
        { kind: "learn", at: iso ?? new Date().toISOString(), results: res.results },
        ...prev,
      ]);
      await refresh();
    },
    [refresh],
  );

  /** POST /maintain now=… → snapshot-diff for prunes, append a maintain run, refresh. */
  const handleMaintain = React.useCallback(
    async (iso?: string) => {
      // snapshot BEFORE so we can reconstruct PRUNED tombstones (prune emits no event).
      const before = await api.beliefs(true).catch(() => [] as Belief[]);
      const res = await api.maintain(iso);
      const after = await refresh();
      const pruned = diffPruned(before, after);
      setPrunedCount((n) => n + pruned.length);
      setLastMaintain(res);
      setRuns((prev) => [
        { kind: "maintain", at: iso ?? new Date().toISOString(), response: res },
        ...prev,
      ]);
      // flash the rows the engine just demoted as they slide down a lane.
      const demotedIds = new Set(res.demoted.map(([id]) => id));
      if (demotedIds.size > 0) {
        setFlashDemotedIds(demotedIds);
        if (demoteTimer.current) clearTimeout(demoteTimer.current);
        demoteTimer.current = setTimeout(() => setFlashDemotedIds(new Set()), 1600);
      }
    },
    [refresh],
  );

  /**
   * THE SIGNATURE INTERACTION — retrieve warm-up. POST /retrieve, then refetch /beliefs so
   * the touched belief's row physically slides dormant → active (its last_accessed_at reset +
   * promote), and flag it as the pulseId the TierLadder consumes for the cyan pulse + the
   * histogram dot jump. The pulse clears after a beat.
   */
  const handleRetrieve = React.useCallback(
    async (query: string, iso?: string) => {
      const hits = await api.retrieve(query, 5, iso);
      const refreshed = await refresh();
      // the warmed belief is the top hit; prefer one that exists in the refreshed snapshot.
      const warmed =
        hits.find((h) => refreshed.some((b) => b.id === h.id)) ?? hits[0];
      if (warmed) {
        setSelectedId(warmed.id);
        setPulseId(warmed.id);
        if (pulseTimer.current) clearTimeout(pulseTimer.current);
        pulseTimer.current = setTimeout(() => setPulseId(null), 2400);
      }
    },
    [refresh],
  );

  /** POST /ingest a quick note episode (does not learn — run learn next to reconcile). */
  const handleIngest = React.useCallback(
    async (text: string, iso?: string) => {
      const occurred_at = iso ?? new Date().toISOString();
      await api.ingest([
        { source: "notes", kind: "entry", payload: { text }, occurred_at },
      ]);
      await refresh();
    },
    [refresh],
  );

  React.useEffect(
    () => () => {
      if (pulseTimer.current) clearTimeout(pulseTimer.current);
      if (demoteTimer.current) clearTimeout(demoteTimer.current);
    },
    [],
  );

  /** Dispatch a CommandPalette intent to the matching handler. */
  const runIntent = React.useCallback(
    async (intent: PaletteIntent) => {
      switch (intent.verb) {
        case "learn":
          await handleLearn(intent.now);
          break;
        case "maintain":
          await handleMaintain(intent.now);
          break;
        case "retrieve":
          await handleRetrieve(intent.query, intent.now);
          break;
        case "ingest":
          await handleIngest(intent.text, intent.now);
          break;
        case "replay":
          await handleResetSession(intent.scenario);
          break;
        case "reset-session":
          await handleResetSession(intent.scenario);
          break;
        case "inspect":
          // navigation handled inside the palette; mirror selection here.
          setSelectedId(intent.beliefId);
          break;
      }
    },
    [handleLearn, handleMaintain, handleRetrieve, handleIngest, handleResetSession],
  );

  // time-travel domain: earliest belief formation → max(now, latest activity).
  const domain = React.useMemo(() => {
    const instants: number[] = [];
    for (const b of beliefs) {
      const s = ms(b.validity_start) ?? ms(b.created_at);
      if (s != null) instants.push(s);
      const u = ms(b.updated_at);
      if (u != null) instants.push(u);
      const e = ms(b.validity_end);
      if (e != null) instants.push(e);
    }
    const min = instants.length ? Math.min(...instants) : nowMs - 30 * 86_400_000;
    const max = Math.max(nowMs, instants.length ? Math.max(...instants) : nowMs);
    return { start: min, end: max };
  }, [beliefs, nowMs]);

  // ---- render ----

  if (state.status === "loading") {
    return (
      <div className="flex items-center gap-2 px-6 py-16">
        <Loader2 size={16} className="animate-spin text-accent" />
        <Mono faint className="text-xs">
          seeding scratch session… POST /session/reset {DEFAULT_SCENARIO} · GET /beliefs?all=true
        </Mono>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="p-6">
        <EmptyState
          icon={AlertTriangle}
          tone="error"
          title="Could not start the Mind Monitor"
          detail={
            <div className="space-y-2 text-left">
              <Mono faint className="block text-xs">
                {state.status_code ? `${state.status_code} · ` : ""}
                {state.message}
              </Mono>
              <p className="font-sans text-xs leading-relaxed text-ink-dim">
                The monitor reads a server-seeded scratch session at{" "}
                <Mono className="text-2xs">{api.base}</Mono>. Make sure the Cortex API is
                running and reachable.
              </p>
            </div>
          }
        />
      </div>
    );
  }

  const { stats } = state.data;
  const scenarioLabel = session.scenario
    ? `scratch·${session.scenario}`
    : stats?.scenario
      ? `scratch·${stats.scenario}`
      : "scratch session";

  return (
    <div className="flex min-h-0 flex-col gap-4 p-4 lg:p-6">
      {/* ── headline vitals ── */}
      <KpiStrip
        beliefs={beliefs}
        prunedCount={prunedCount}
        lastLearn={lastLearn}
        lastMaintain={lastMaintain}
      />

      {/* ── top band: BELIEFS BY TIER ladder │ RECONCILIATION STREAM ── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="flex min-h-0 flex-col rounded-md border border-border bg-surface-1 p-3 lg:p-4">
          <TierLadder
            beliefs={beliefs}
            selectedId={selectedId}
            onSelect={setSelectedId}
            now={now}
            weights={weights}
            thresholds={thresholds}
            pulseId={pulseId ?? selectedId}
            flashDemotedIds={flashDemotedIds}
            onRetrieve={(b) => void handleRetrieve(b.statement, nowIso(now))}
            className="min-h-0 flex-1"
          />
        </section>

        <section className="flex min-h-0 flex-col rounded-md border border-border bg-surface-1 p-3 lg:p-4">
          <ReconciliationStream
            runs={runs}
            beliefs={beliefsById}
            timelines={timelines}
            live
            scenario={scenarioLabel}
            onSelectBelief={setSelectedId}
            className="min-h-0 flex-1"
          />
        </section>
      </div>

      {/* ── bottom band: RETENTION DISTRIBUTION │ FORMATION/FORGETTING curve ── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="rounded-md border border-border bg-surface-1 p-3 lg:p-4">
          <RetentionHistogram
            beliefs={beliefs}
            selectedId={selectedId}
            now={now}
            weights={weights}
            thresholds={thresholds}
          />
        </section>

        <section className="rounded-md border border-border bg-surface-1 p-3 lg:p-4">
          <LifecycleCurve
            points={points}
            annotations={annotations}
            now={nowMs}
            halflifeDays={weights.recency_halflife_days}
            selectedId={null}
          />
        </section>
      </div>

      {/* ── global Time-Travel scrubber — drives `now` on /learn /maintain /retrieve ── */}
      <TimeTravelScrubber
        domainStart={domain.start}
        domainEnd={domain.end}
        scenario={session.scenario}
        onReplay={handleResetSession}
        onLearn={() => handleLearn(nowIso(now))}
        onMaintain={() => handleMaintain(nowIso(now))}
      />

      {/* ── ⌘K command palette — fuzzy verb runner, all against the scratch session ── */}
      <CommandPalette beliefs={beliefs} onRun={runIntent} />
    </div>
  );
}
