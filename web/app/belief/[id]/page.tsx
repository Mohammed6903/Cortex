"use client";

/**
 * Belief Inspector — /belief/[id]
 *
 * The forensic, single-belief view. Layout matches the "Belief Inspector" mockup in
 * docs/ui-design-cortex-vitals.md:
 *
 *   ┌ BELIEF (header card) ──────────────┬ STATE AS OF SELECTED EVENT (right rail) ┐
 *   ├────────────────────────────────────┴─────────────────────────────────────────┤
 *   │ LIFECYCLE TIMELINE (git-style branching) — full width                         │
 *   └───────────────────────────────────────────────────────────────────────────────┘
 *
 * This integrator stitches the four Phase-2 leaf components together and owns the shared
 * state they coordinate on:
 *   - the three fetches: GET /beliefs/{id}, /beliefs/{id}/timeline, /beliefs/{id}/provenance
 *   - the selected timeline event (drives StateAsOfPane's fold + the DiffDrawer)
 *   - the diff drawer open flag + the post-collapse event it inspects
 *   - the provenance drawer (the header's provenance affordance)
 *   - the `now` time-cursor (from useSession) shared by the timeline + the estimates
 *
 * Honesty constraints upheld at this layer:
 *   - We pass the RAW (uncollapsed) timeline to StateAsOfPane — it folds the supersede
 *     pair itself. BeliefTimeline collapses internally for display + passes the *collapsed*
 *     row to onSelectEvent / onOpenDiff, so we map that row back to a RAW index for the fold.
 *   - There is no `branched` event type; the timeline + diff handle branch == contradicted
 *     w/ detail.kind==="branch". We invent nothing here.
 *   - PRUNED has no event: if a belief 404s we say so honestly (it may have been pruned —
 *     reconstructable only via snapshot-diff on the Monitor, never fabricated here).
 *   - This page is a pure read of the scratch session; it never mutates the store.
 */

import * as React from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  Loader2,
  ListTree,
} from "lucide-react";

import {
  api,
  ApiError,
  type Belief,
  type BeliefEvent,
  type Episode,
  type ConfigResponse,
} from "@/lib/api";
import {
  weightsFromConfig,
  thresholdsFromConfig,
  type RetentionThresholds,
  type RetentionWeights,
} from "@/lib/retention";
import { Drawer, EmptyState, Mono } from "@/components/primitives";
import { useSession } from "@/components/SessionContext";

import { BeliefHeaderCard } from "@/components/inspector/BeliefHeaderCard";
import { BeliefTimeline } from "@/components/inspector/BeliefTimeline";
import { StateAsOfPane } from "@/components/inspector/StateAsOfPane";
import { DiffDrawer } from "@/components/inspector/DiffDrawer";

// ---------------------------------------------------------------------------
// load state
// ---------------------------------------------------------------------------

interface InspectorData {
  belief: Belief;
  events: BeliefEvent[];
  provenance: Episode[];
}

type LoadState =
  | { status: "loading" }
  | { status: "notfound"; id: string }
  | { status: "error"; message: string; status_code: number }
  | { status: "ready"; data: InspectorData };

/** Stable identity for a timeline event (id when present, else event_type+instant). */
function eventKey(e: BeliefEvent): string {
  return e.id != null ? `id:${e.id}` : `${e.event_type}@${e.at}`;
}

/**
 * Map a (possibly collapsed) selected row back to its index in the RAW events array, so
 * StateAsOfPane folds through the correct instant. The collapse only ever *drops* the
 * redundant `contradicted` partner of a supersede and keeps the `superseded` row's
 * identity, so matching on event id (then event_type+at) is exact.
 */
function rawIndexOf(raw: BeliefEvent[], selected: BeliefEvent | null): number | null {
  if (!selected) return null;
  const key = eventKey(selected);
  const idx = raw.findIndex((e) => eventKey(e) === key);
  return idx === -1 ? null : idx;
}

// ---------------------------------------------------------------------------
// page
// ---------------------------------------------------------------------------

export default function BeliefInspectorPage({
  params,
}: {
  params: { id: string };
}) {
  const beliefId = params.id;
  const session = useSession();

  const [state, setState] = React.useState<LoadState>({ status: "loading" });
  const [config, setConfig] = React.useState<ConfigResponse | null>(null);

  // shared selection + drawers
  const [selectedEvent, setSelectedEvent] = React.useState<BeliefEvent | null>(null);
  const [diffOpen, setDiffOpen] = React.useState(false);
  const [diffEvent, setDiffEvent] = React.useState<BeliefEvent | null>(null);
  const [provOpen, setProvOpen] = React.useState(false);

  // ---- fetch belief + timeline + provenance (and config, best-effort) ----
  React.useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    setSelectedEvent(null);
    setDiffOpen(false);
    setDiffEvent(null);
    setProvOpen(false);

    async function load() {
      // belief first: a 404 here is the honest "pruned / unknown" branch.
      let belief: Belief;
      try {
        belief = await api.belief(beliefId);
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 404) {
          setState({ status: "notfound", id: beliefId });
        } else {
          setState({
            status: "error",
            message: e instanceof Error ? e.message : String(e),
            status_code: e instanceof ApiError ? e.status : 0,
          });
        }
        return;
      }

      // timeline + provenance in parallel; provenance is non-fatal (degrade to []).
      const [events, provenance] = await Promise.all([
        api.timeline(beliefId).catch(() => [] as BeliefEvent[]),
        api.provenance(beliefId).catch(() => [] as Episode[]),
      ]);
      if (cancelled) return;
      setState({ status: "ready", data: { belief, events, provenance } });
    }

    void load();
    // config is independent + cached-ish; failure just falls back to lib constants.
    api
      .config()
      .then((c) => {
        if (!cancelled) setConfig(c);
      })
      .catch(() => {
        /* fall back to RETENTION_WEIGHTS / RETENTION_THRESHOLDS */
      });

    return () => {
      cancelled = true;
    };
  }, [beliefId]);

  const weights = React.useMemo(() => weightsFromConfig(config), [config]);
  const thresholds = React.useMemo(() => thresholdsFromConfig(config), [config]);

  // ---- selection handlers (passed down to the timeline) ----
  const handleSelectEvent = React.useCallback((e: BeliefEvent) => {
    setSelectedEvent((prev) =>
      prev && eventKey(prev) === eventKey(e) ? null : e,
    );
  }, []);

  const handleOpenDiff = React.useCallback((e: BeliefEvent) => {
    setSelectedEvent(e);
    setDiffEvent(e);
    setDiffOpen(true);
  }, []);

  const handleToggleDiffFromPane = React.useCallback(() => {
    if (selectedEvent) {
      setDiffEvent(selectedEvent);
      setDiffOpen(true);
    }
  }, [selectedEvent]);

  // ---- render ----

  return (
    <div className="flex min-h-0 flex-col gap-4 p-4 lg:p-6">
      <InspectorTopline beliefId={beliefId} />

      {state.status === "loading" ? (
        <div className="flex items-center gap-2 px-2 py-16">
          <Loader2 size={16} className="animate-spin text-accent" />
          <Mono faint className="text-xs">
            loading belief… GET /beliefs/{beliefId}
          </Mono>
        </div>
      ) : state.status === "notfound" ? (
        <NotFoundState id={state.id} />
      ) : state.status === "error" ? (
        <EmptyState
          icon={AlertTriangle}
          tone="error"
          title="Could not load this belief"
          detail={
            <Mono faint className="text-xs">
              {state.status_code ? `${state.status_code} · ` : ""}
              {state.message}
            </Mono>
          }
        />
      ) : (
        <ReadyInspector
          data={state.data}
          now={session.now}
          weights={weights}
          thresholds={thresholds}
          selectedEvent={selectedEvent}
          onSelectEvent={handleSelectEvent}
          onOpenDiff={handleOpenDiff}
          onToggleDiffFromPane={handleToggleDiffFromPane}
          diffOpen={diffOpen}
          diffEvent={diffEvent}
          onCloseDiff={() => setDiffOpen(false)}
          provOpen={provOpen}
          onOpenProvenance={() => setProvOpen(true)}
          onCloseProvenance={() => setProvOpen(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// topline (page chrome: back link + route truth + ledger link)
// ---------------------------------------------------------------------------

function InspectorTopline({ beliefId }: { beliefId: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-3">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 rounded border border-border bg-surface-1 px-2 py-1 text-ink-dim transition-colors hover:border-accent/60 hover:text-ink"
        >
          <ArrowLeft size={13} aria-hidden />
          <Mono className="text-2xs uppercase tracking-wide">monitor</Mono>
        </Link>
        <Mono dim className="text-xs uppercase tracking-widest">
          Belief Inspector
        </Mono>
        <Mono faint className="text-2xs">
          inspect {beliefId}
        </Mono>
      </div>
      <Link
        href="/beliefs"
        className="inline-flex items-center gap-1.5 rounded border border-border bg-surface-1 px-2 py-1 text-ink-dim transition-colors hover:border-accent/60 hover:text-ink"
      >
        <ListTree size={13} aria-hidden />
        <Mono className="text-2xs uppercase tracking-wide">ledger ▸</Mono>
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------
// not-found (honest "pruned / unknown" branch)
// ---------------------------------------------------------------------------

function NotFoundState({ id }: { id: string }) {
  return (
    <EmptyState
      icon={AlertTriangle}
      title="No such belief in the scratch session"
      detail={
        <div className="space-y-2 text-left">
          <Mono faint className="block text-xs">
            GET /beliefs/{id} → 404
          </Mono>
          <p className="font-sans text-xs leading-relaxed text-ink-dim">
            This id isn&apos;t held by the current scratch session. If it once existed it may
            have been <Mono className="text-2xs">pruned</Mono> — and prune emits{" "}
            <span className="text-ink">no event</span>, so a pruned belief is gone from the
            store entirely. The only honest way to surface a prune is a snapshot-diff of two{" "}
            <Mono className="text-2xs">GET /beliefs?all=true</Mono> reads across a maintain
            (see the Mind Monitor tombstones), never a reconstructed inspector page.
          </p>
        </div>
      }
      action={
        <Link
          href="/beliefs"
          className="inline-flex items-center gap-1.5 rounded border border-border bg-surface-1 px-3 py-1.5 text-ink-dim transition-colors hover:border-accent/60 hover:text-ink"
        >
          <ListTree size={13} aria-hidden />
          <Mono className="text-2xs uppercase tracking-wide">open the ledger</Mono>
        </Link>
      }
    />
  );
}

// ---------------------------------------------------------------------------
// the assembled, data-ready inspector
// ---------------------------------------------------------------------------

function ReadyInspector({
  data,
  now,
  weights,
  thresholds,
  selectedEvent,
  onSelectEvent,
  onOpenDiff,
  onToggleDiffFromPane,
  diffOpen,
  diffEvent,
  onCloseDiff,
  provOpen,
  onOpenProvenance,
  onCloseProvenance,
}: {
  data: InspectorData;
  now: Date;
  weights: RetentionWeights;
  thresholds: RetentionThresholds;
  selectedEvent: BeliefEvent | null;
  onSelectEvent: (e: BeliefEvent) => void;
  onOpenDiff: (e: BeliefEvent) => void;
  onToggleDiffFromPane: () => void;
  diffOpen: boolean;
  diffEvent: BeliefEvent | null;
  onCloseDiff: () => void;
  provOpen: boolean;
  onOpenProvenance: () => void;
  onCloseProvenance: () => void;
}) {
  const { belief, events, provenance } = data;

  // RAW events sorted oldest→newest, exactly as StateAsOfPane wants them (uncollapsed).
  const rawEvents = React.useMemo(
    () =>
      [...events].sort(
        (a, b) => Date.parse(a.at || "") - Date.parse(b.at || ""),
      ),
    [events],
  );

  // The fold index for the right rail: null = "now" (fold whole history).
  const selectedIndex = React.useMemo(
    () => rawIndexOf(rawEvents, selectedEvent),
    [rawEvents, selectedEvent],
  );

  const formedOnly =
    rawEvents.length <= 1 &&
    belief.reinforcement_count === 0 &&
    belief.last_accessed_at == null &&
    belief.superseded_by == null;

  return (
    <>
      {/* ── top band: header card + state-as-of rail (the mockup's split) ── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
        <BeliefHeaderCard
          belief={belief}
          now={now}
          weights={weights}
          thresholds={thresholds}
          onOpenProvenance={onOpenProvenance}
          provenanceCount={provenance.length}
        />

        <StateAsOfPane
          belief={belief}
          events={rawEvents}
          selectedIndex={selectedIndex}
          now={now}
          onToggleDiff={onToggleDiffFromPane}
        />
      </div>

      {/* honest formed-only banner mirrors the mockup's note for a fresh belief */}
      {formedOnly ? (
        <div className="rounded-md border border-dashed border-border bg-surface-0 px-3 py-2">
          <Mono faint className="text-2xs leading-relaxed">
            formed-only belief — no reinforcement, contradiction, supersede, or maintain has
            touched it yet. The timeline below shows just its formation; retention decays
            from created_at on recency alone and last_access reads &ldquo;never&rdquo;.
          </Mono>
        </div>
      ) : null}

      {/* ── lifecycle timeline: full width, the hero ── */}
      <section className="rounded-md border border-border bg-surface-1 p-3 lg:p-4">
        <BeliefTimeline
          beliefId={belief.id}
          events={rawEvents}
          now={now}
          selectedEventId={selectedEvent?.id ?? null}
          onSelectEvent={onSelectEvent}
          onOpenDiff={onOpenDiff}
        />
      </section>

      {/* ── before/after reconciliation drawer (supersede / branch / merge) ── */}
      <DiffDrawer
        open={diffOpen}
        onClose={onCloseDiff}
        event={diffEvent}
        before={belief}
      />

      {/* ── provenance drawer (header affordance owns it here) ── */}
      <ProvenanceDrawer
        open={provOpen}
        onClose={onCloseProvenance}
        beliefId={belief.id}
        episodes={provenance}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// provenance drawer (the source episodes for the whole belief)
// ---------------------------------------------------------------------------

function fmtTs(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`
  );
}

function ProvenanceDrawer({
  open,
  onClose,
  beliefId,
  episodes,
}: {
  open: boolean;
  onClose: () => void;
  beliefId: string;
  episodes: Episode[];
}) {
  return (
    <Drawer open={open} onClose={onClose} width={480} title="provenance">
      <div className="space-y-3">
        <Mono faint className="block text-2xs">
          GET /beliefs/{beliefId}/provenance — the immutable episodes this belief was
          distilled / corroborated from.
        </Mono>

        {episodes.length === 0 ? (
          <EmptyState
            title="No source episodes still present"
            detail="This belief has no recorded provenance in the current scratch session (the source episodes may not have been ingested, or were never linked)."
          />
        ) : (
          <ol className="space-y-2">
            {episodes.map((ep) => (
              <li
                key={ep.id}
                className="rounded-md border border-border bg-surface-0 px-3 py-2"
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <Mono className="text-2xs" style={{ color: "#9B7FD8" }}>
                    {ep.id}
                  </Mono>
                  <Mono faint className="text-2xs">
                    {ep.source}/{ep.kind}
                  </Mono>
                </div>
                {typeof ep.payload?.text === "string" ? (
                  <p className="mt-1 font-sans text-xs leading-relaxed text-ink-dim">
                    &ldquo;{ep.payload.text}&rdquo;
                  </p>
                ) : Object.keys(ep.payload ?? {}).length > 0 ? (
                  <Mono faint className="mt-1 block break-all text-2xs">
                    {JSON.stringify(ep.payload)}
                  </Mono>
                ) : null}
                <Mono faint className="mt-1 block text-2xs">
                  occurred {fmtTs(ep.occurred_at)} · ingested {fmtTs(ep.ingested_at)}
                </Mono>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Drawer>
  );
}
