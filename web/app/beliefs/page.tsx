"use client";

/**
 * Belief Ledger — `/beliefs`
 *
 * A dense, mono "machine-truth" table of GET /beliefs?all=true. Every column except the
 * `statement` is JetBrains Mono (ids, floats, timestamps, counts), and every row's OPACITY
 * encodes confidence — a 0.28 belief literally fades, a 0.91 reads heavy (design grammar).
 *
 * Three views the doc calls for:
 *   - grouped by tier (active → dormant → archived), the default, mirroring the tier ramp;
 *   - a flat "sort by retention" (client estimate, descending), so you can scan the cooling
 *     edge top-to-bottom and see who is about to cross a cliff;
 *   - PRUNED tombstone rows, reconstructed by snapshot-diffing two /beliefs?all=true reads
 *     across a maintain — never the live store (the ledger runs maintain on the SCRATCH
 *     session and labels the action). Prune emits no event, so this diff is the only honest
 *     source; tombstone rows render outline-only and struck-through.
 *
 * Honesty constraints upheld:
 *   - Retention is the CLIENT estimate (lib/retention), explicitly labeled `e`, fed by
 *     GET /config so it tracks the engine; thresholds shown in the header.
 *   - We never mutate the live store. The page boots against the seeded scratch session and
 *     the only mutating affordance ("maintain → reveal prunes") runs on that scratch db.
 *
 * A lightweight virtualization stub keeps long ledgers cheap: rows outside a windowed slice
 * are replaced by a single spacer so the DOM never holds thousands of nodes. The window is
 * driven by the scroll container; it is a STUB (fixed row height, generous overscan) — honest
 * about being a simplification, not a full windowing library.
 */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, ListTree, Loader2, RefreshCw } from "lucide-react";

import {
  api,
  ApiError,
  type Belief,
  type ConfigResponse,
  type TierName,
} from "@/lib/api";
import {
  estimateRetention,
  weightsFromConfig,
  thresholdsFromConfig,
  type RetentionThresholds,
  type RetentionWeights,
} from "@/lib/retention";
import { diffPruned } from "@/lib/events";
import { nowIso, DEFAULT_SCENARIO } from "@/lib/session";
import {
  TIER_COLOR,
  TIER_LABEL,
  TYPE_LABEL,
  fmtFloat,
  opacityFromConfidence,
  weightFromConfidence,
} from "@/lib/tokens";
import { Mono, EmptyState } from "@/components/primitives";
import { useSession } from "@/components/SessionContext";

// ---------------------------------------------------------------------------
// load state
// ---------------------------------------------------------------------------

interface LedgerData {
  beliefs: Belief[];
  config: ConfigResponse | null;
  /** PRUNED tombstones reconstructed via snapshot-diff across a maintain (empty until run). */
  pruned: Belief[];
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string; code: number }
  | { status: "ready"; data: LedgerData };

type SortMode = "tier" | "retention";

const TIER_ORDER: TierName[] = ["active", "dormant", "archived"];

// ---------------------------------------------------------------------------
// row model — a belief + its client retention estimate (or a pruned tombstone)
// ---------------------------------------------------------------------------

interface LedgerRow {
  belief: Belief;
  /** estimated retention score [0,1], or null for a tombstone (no live state to score). */
  score: number | null;
  willDemote: boolean;
  pruneEligible: boolean;
  /** true when this is a reconstructed PRUNED tombstone (absent from the live read). */
  tombstone: boolean;
}

function buildRow(
  belief: Belief,
  now: Date | number,
  weights: RetentionWeights,
  thresholds: RetentionThresholds,
  tombstone = false,
): LedgerRow {
  if (tombstone) {
    return { belief, score: null, willDemote: false, pruneEligible: false, tombstone };
  }
  const est = estimateRetention(belief, now, weights, thresholds);
  return {
    belief,
    score: est.score,
    willDemote: est.willDemote,
    pruneEligible: est.pruneEligible,
    tombstone: false,
  };
}

// ---------------------------------------------------------------------------
// virtualization stub — window a long row list to a visible slice + overscan
// ---------------------------------------------------------------------------

const ROW_HEIGHT = 30; // px — fixed; the stub trades exactness for cheapness.
const OVERSCAN = 8;

/**
 * A deliberately simple windowing stub: given the scroll offset + viewport height of a
 * container and a fixed ROW_HEIGHT, return the [start,end) row range to render plus the top
 * spacer height. NOT a full virtualization lib (no dynamic measurement / no binary search) —
 * honest about being a stub, but enough to keep thousands of rows off the DOM.
 */
function windowRange(
  scrollTop: number,
  viewport: number,
  total: number,
): { start: number; end: number; padTop: number; padBottom: number } {
  if (total === 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visible = Math.ceil(viewport / ROW_HEIGHT) + OVERSCAN * 2;
  const start = first;
  const end = Math.min(total, first + visible);
  return {
    start,
    end,
    padTop: start * ROW_HEIGHT,
    padBottom: (total - end) * ROW_HEIGHT,
  };
}

// ---------------------------------------------------------------------------
// page
// ---------------------------------------------------------------------------

export default function LedgerPage() {
  const session = useSession();
  const { now, setScenario } = session;
  const router = useRouter();

  const [state, setState] = React.useState<LoadState>({ status: "loading" });
  const [sort, setSort] = React.useState<SortMode>("tier");
  const [maintaining, setMaintaining] = React.useState(false);

  // ---- boot: seed the scratch session if the chrome shows none, then read ----
  React.useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });

    async function boot() {
      try {
        // If a session was already seeded by the Monitor, reuse it; otherwise seed one so the
        // ledger is never empty AND so the maintain affordance has a scratch db to run on.
        if (!session.isScratch) {
          const reset = await api.resetSession(DEFAULT_SCENARIO);
          if (cancelled) return;
          if (reset.ok) setScenario(DEFAULT_SCENARIO, true);
        }
        const beliefs = await api.beliefs(true);
        if (cancelled) return;
        const config = await api.config().catch(() => null);
        if (cancelled) return;
        setState({ status: "ready", data: { beliefs, config, pruned: [] } });
      } catch (e) {
        if (cancelled) return;
        setState({
          status: "error",
          message: e instanceof Error ? e.message : String(e),
          code: e instanceof ApiError ? e.status : 0,
        });
      }
    }

    void boot();
    return () => {
      cancelled = true;
    };
    // boot once on mount; isScratch is read as an initial hint only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setScenario]);

  const config = state.status === "ready" ? state.data.config : null;
  const weights = React.useMemo<RetentionWeights>(
    () => weightsFromConfig(config),
    [config],
  );
  const thresholds = React.useMemo<RetentionThresholds>(
    () => thresholdsFromConfig(config),
    [config],
  );

  const beliefs = React.useMemo<Belief[]>(
    () => (state.status === "ready" ? state.data.beliefs : []),
    [state],
  );
  const pruned = React.useMemo<Belief[]>(
    () => (state.status === "ready" ? state.data.pruned : []),
    [state],
  );

  // ---- refetch the live scratch read ----
  const refresh = React.useCallback(async () => {
    const beliefsAll = await api.beliefs(true);
    const cfg = await api.config().catch(() => null);
    setState({ status: "ready", data: { beliefs: beliefsAll, config: cfg, pruned } });
    return beliefsAll;
  }, [pruned]);

  // ---- maintain → reconstruct PRUNED tombstones via snapshot-diff (scratch only) ----
  const handleMaintain = React.useCallback(async () => {
    if (state.status !== "ready") return;
    setMaintaining(true);
    try {
      const before = await api.beliefs(true);
      await api.maintain(nowIso(now));
      const after = await api.beliefs(true);
      const cfg = await api.config().catch(() => null);
      const newlyPruned = diffPruned(before, after);
      // accumulate tombstones (dedupe by id so repeated maintains don't double-count).
      const seen = new Set(pruned.map((b) => b.id));
      const merged = [...pruned, ...newlyPruned.filter((b) => !seen.has(b.id))];
      setState({
        status: "ready",
        data: { beliefs: after, config: cfg, pruned: merged },
      });
    } catch {
      // best-effort; leave the prior state on failure.
    } finally {
      setMaintaining(false);
    }
  }, [state.status, now, pruned]);

  const nowMs = now.getTime();

  // ---- build display rows: grouped-by-tier OR flat-by-retention, + tombstones ----
  const grouped = React.useMemo(() => {
    const tombstoneRows = pruned.map((b) =>
      buildRow(b, nowMs, weights, thresholds, true),
    );
    if (sort === "retention") {
      const live = beliefs.map((b) => buildRow(b, nowMs, weights, thresholds));
      // tombstones sort last (no score), live rows by descending estimated retention.
      const flat = [...live].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      return [
        { key: "retention" as const, label: "by retention (est, desc)", color: "#9AA3AF", rows: flat },
        ...(tombstoneRows.length
          ? [{ key: "pruned" as const, label: TIER_LABEL.pruned, color: TIER_COLOR.pruned, rows: tombstoneRows }]
          : []),
      ];
    }
    // grouped by tier, each lane sorted by descending retention
    const lanes = TIER_ORDER.map((tier) => {
      const rows = beliefs
        .filter((b) => b.tier === tier)
        .map((b) => buildRow(b, nowMs, weights, thresholds))
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      return { key: tier, label: TIER_LABEL[tier], color: TIER_COLOR[tier], rows };
    });
    if (tombstoneRows.length) {
      lanes.push({
        key: "pruned" as TierName,
        label: TIER_LABEL.pruned,
        color: TIER_COLOR.pruned,
        rows: tombstoneRows,
      });
    }
    return lanes;
  }, [beliefs, pruned, sort, nowMs, weights, thresholds]);

  const totalRows = React.useMemo(
    () => grouped.reduce((n, g) => n + g.rows.length, 0),
    [grouped],
  );

  // ---- render ----

  if (state.status === "loading") {
    return (
      <div className="flex items-center gap-2 px-6 py-16">
        <Loader2 size={16} className="animate-spin text-accent" />
        <Mono faint className="text-xs">
          reading ledger… GET /beliefs?all=true
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
          title="Could not load the Belief Ledger"
          detail={
            <div className="space-y-2 text-left">
              <Mono faint className="block text-xs">
                {state.code ? `${state.code} · ` : ""}
                {state.message}
              </Mono>
              <p className="font-sans text-xs leading-relaxed text-ink-dim">
                The ledger reads a server-seeded scratch session at{" "}
                <Mono className="text-2xs">{api.base}</Mono>. Make sure the Cortex API is
                running.
              </p>
            </div>
          }
        />
      </div>
    );
  }

  const scenarioLabel = session.scenario
    ? `scratch·${session.scenario}`
    : "scratch session";

  return (
    <div className="flex min-h-0 flex-col gap-3 p-4 lg:p-6">
      {/* ── header ── */}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ListTree size={15} className="text-accent" />
          <Mono className="text-xs uppercase tracking-widest text-ink">
            Belief Ledger
          </Mono>
          <Mono faint className="text-2xs">
            {scenarioLabel} · {beliefs.length} held+history
            {pruned.length ? ` · ${pruned.length} tombstone${pruned.length === 1 ? "" : "s"}` : ""}
          </Mono>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* sort toggle */}
          <div
            className="inline-flex overflow-hidden rounded-md border border-border"
            role="group"
            aria-label="Sort mode"
          >
            <SortButton active={sort === "tier"} onClick={() => setSort("tier")}>
              by tier
            </SortButton>
            <SortButton
              active={sort === "retention"}
              onClick={() => setSort("retention")}
            >
              by retention
            </SortButton>
          </div>

          {/* maintain → reveal prunes (scratch only) */}
          <button
            type="button"
            onClick={() => void handleMaintain()}
            disabled={maintaining}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2.5 py-1 text-ink-dim transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-50"
            title="POST /maintain on the scratch session, then snapshot-diff to reconstruct PRUNED tombstones (prune emits no event)."
          >
            {maintaining ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <RefreshCw size={12} />
            )}
            <Mono className="text-2xs">maintain → reveal prunes</Mono>
          </button>

          <Link
            href="/"
            className="rounded-md border border-border bg-surface-1 px-2.5 py-1 text-ink-dim transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <Mono className="text-2xs">◂ Monitor</Mono>
          </Link>
        </div>
      </header>

      {/* ── retention formula caption (honest labeling) ── */}
      <Mono faint className="text-2xs">
        retention est · client · w sal {fmtFloat(weights.w_salience, 1)} reinf{" "}
        {fmtFloat(weights.w_reinforcement, 1)} rec {fmtFloat(weights.w_recency, 1)} · hl
        {weights.recency_halflife_days}d · cliffs {fmtFloat(thresholds.dormant_retention_max)}/
        {fmtFloat(thresholds.archive_retention_max)} · opacity = confidence · weight = confidence
      </Mono>

      {/* ── the dense table ── */}
      {totalRows === 0 ? (
        <EmptyState
          icon={ListTree}
          title="No beliefs in this session"
          detail="Reset or replay a scenario from the Monitor's command palette to populate the ledger."
        />
      ) : (
        <LedgerTable groups={grouped} totalRows={totalRows} router={router} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// the table — sticky column header + grouped, virtualized rows
// ---------------------------------------------------------------------------

interface Group {
  key: string;
  label: string;
  color: string;
  rows: LedgerRow[];
}

function LedgerTable({
  groups,
  totalRows,
  router,
}: {
  groups: Group[];
  totalRows: number;
  router: ReturnType<typeof useRouter>;
}) {
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = React.useState(0);
  const [viewport, setViewport] = React.useState(600);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => setScrollTop(el.scrollTop);
    const measure = () => setViewport(el.clientHeight);
    measure();
    el.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      el.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", measure);
    };
  }, []);

  // Flatten groups into a single index space (header counts as a row) so the windowing stub
  // can window across group boundaries. Each "slot" is either a group header or a belief row.
  type Slot =
    | { kind: "header"; group: Group }
    | { kind: "row"; group: Group; row: LedgerRow };
  const slots = React.useMemo<Slot[]>(() => {
    const out: Slot[] = [];
    for (const g of groups) {
      out.push({ kind: "header", group: g });
      for (const row of g.rows) out.push({ kind: "row", group: g, row });
    }
    return out;
  }, [groups]);

  const { start, end, padTop, padBottom } = windowRange(
    scrollTop,
    viewport,
    slots.length,
  );
  const slice = slots.slice(start, end);

  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-md border border-border bg-surface-1">
      {/* sticky column header */}
      <div
        className="grid grid-cols-[minmax(0,1fr)_88px_64px_64px_44px_72px_148px] items-center gap-2 border-b border-border px-3 py-2"
        aria-hidden
      >
        <ColHead>statement</ColHead>
        <ColHead>id</ColHead>
        <ColHead title="confidence">conf</ColHead>
        <ColHead title="salience">sal</ColHead>
        <ColHead title="reinforcement count">↑n</ColHead>
        <ColHead title="estimated retention (client)">ret·e</ColHead>
        <ColHead title="last accessed (touch)">last access</ColHead>
      </div>

      {/* virtualized body */}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-auto"
        style={{ contain: "strict" }}
      >
        {/* top spacer for windowed-out rows */}
        <div style={{ height: padTop }} aria-hidden />
        {slice.map((slot, i) => {
          if (slot.kind === "header") {
            return (
              <GroupHeader
                key={`h:${slot.group.key}:${start + i}`}
                group={slot.group}
              />
            );
          }
          return (
            <LedgerRowView
              key={`r:${slot.row.belief.id}:${start + i}`}
              row={slot.row}
              groupColor={slot.group.color}
              onOpen={(id) => router.push(`/belief/${encodeURIComponent(id)}`)}
            />
          );
        })}
        {/* bottom spacer */}
        <div style={{ height: padBottom }} aria-hidden />
      </div>

      {/* footer — windowing truth */}
      <div className="flex items-center justify-between border-t border-border px-3 py-1.5">
        <Mono faint className="text-2xs">
          {totalRows} row{totalRows === 1 ? "" : "s"} · rendering {slice.length} of{" "}
          {slots.length} slots (virtualization stub · {ROW_HEIGHT}px rows)
        </Mono>
        <Mono faint className="text-2xs">
          click a row → inspector
        </Mono>
      </div>
    </div>
  );
}

function ColHead({
  children,
  title,
}: {
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <Mono faint className="truncate text-2xs uppercase tracking-wide" title={title}>
      {children}
    </Mono>
  );
}

function GroupHeader({ group }: { group: Group }) {
  return (
    <div
      className="flex items-center gap-2 bg-surface-0 px-3"
      style={{ height: ROW_HEIGHT }}
    >
      <Mono className="text-2xs uppercase tracking-wide" style={{ color: group.color }}>
        {group.label}
      </Mono>
      <span
        className="inline-block h-px flex-1"
        style={{ backgroundColor: `${group.color}40` }}
      />
      <Mono className="text-2xs" style={{ color: group.color }}>
        {group.rows.length}
      </Mono>
    </div>
  );
}

function LedgerRowView({
  row,
  groupColor,
  onOpen,
}: {
  row: LedgerRow;
  groupColor: string;
  onOpen: (id: string) => void;
}) {
  const { belief, score, willDemote, pruneEligible, tombstone } = row;
  const opacity = opacityFromConfidence(belief.confidence);
  const weight = weightFromConfidence(belief.confidence);

  return (
    <button
      type="button"
      onClick={() => onOpen(belief.id)}
      className="grid w-full grid-cols-[minmax(0,1fr)_88px_64px_64px_44px_72px_148px] items-center gap-2 border-b border-border/40 px-3 text-left transition-colors hover:bg-surface-2"
      style={{ height: ROW_HEIGHT }}
      title={tombstone ? "PRUNED tombstone — reconstructed via snapshot-diff" : belief.statement}
    >
      {/* statement — Inter prose, opacity + weight = confidence; tombstones struck through */}
      <span className="flex min-w-0 items-center gap-1.5">
        <span
          className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
          style={
            tombstone
              ? { border: `1px solid ${TIER_COLOR.pruned}`, backgroundColor: "transparent" }
              : { backgroundColor: groupColor, opacity: Math.max(opacity, 0.5) }
          }
          aria-hidden
        />
        <span
          className={`truncate font-sans text-xs ${
            tombstone ? "text-ink-faint line-through" : "text-ink"
          }`}
          style={tombstone ? undefined : { opacity, fontWeight: weight }}
        >
          {belief.statement}
        </span>
        <Mono faint className="shrink-0 text-2xs">
          {TYPE_LABEL[belief.type]}
        </Mono>
      </span>

      {/* id */}
      <Mono dim className="truncate text-2xs">
        {belief.id}
      </Mono>

      {/* confidence */}
      <Mono dim className="text-2xs tabular-nums">
        {fmtFloat(belief.confidence)}
      </Mono>

      {/* salience */}
      <Mono dim className="text-2xs tabular-nums">
        {fmtFloat(belief.salience)}
      </Mono>

      {/* reinforcement count */}
      <Mono dim className="text-2xs tabular-nums">
        {belief.reinforcement_count > 0 ? `↑${belief.reinforcement_count}` : "·"}
      </Mono>

      {/* estimated retention — colored when crossing a cliff / prune-eligible */}
      {tombstone ? (
        <Mono faint className="text-2xs">
          pruned
        </Mono>
      ) : pruneEligible ? (
        <Mono className="text-2xs tabular-nums" style={{ color: TIER_COLOR.pruned }}>
          prune?
        </Mono>
      ) : (
        <Mono
          className="text-2xs tabular-nums"
          style={{ color: willDemote ? TIER_COLOR.dormant : "#9AA3AF" }}
          title={
            willDemote
              ? "below the next cliff — would demote on the next maintain"
              : "estimated retention (client)"
          }
        >
          ~{fmtFloat(score ?? 0)}e
        </Mono>
      )}

      {/* last access */}
      <Mono faint className="truncate text-2xs">
        {belief.last_accessed_at
          ? belief.last_accessed_at.slice(0, 16).replace("T", " ")
          : "never"}
      </Mono>
    </button>
  );
}

function SortButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`px-2.5 py-1 transition-colors ${
        active ? "bg-surface-2 text-accent" : "text-ink-dim hover:bg-surface-1 hover:text-ink"
      }`}
    >
      <Mono className="text-2xs">{children}</Mono>
    </button>
  );
}
