"use client";

/**
 * BeliefTimeline — the hero forensic, git-style branching lifecycle view.
 *
 * Source of truth: GET /beliefs/{id}/timeline (raw BeliefEvent[]). This component renders
 * the secondary mockup in docs/ui-design-cortex-vitals.md as closely as the real data
 * grammar allows, and it enforces every honesty constraint at the render layer:
 *
 *   - There is NO `branched` event type. A *branch* is a `contradicted` event whose
 *     detail.kind === "branch" (lib/events.isBranch). It opens a FORKED lane in the gutter
 *     and the contradicted/forked belief is demoted to DORMANT (not archived).
 *   - A *supersede* emits BOTH `contradicted` AND `superseded` for one act — these are
 *     de-duped to a SINGLE row via lib/events.collapseSupersede. It also opens a fork
 *     (the prior belief moves to a side lane and is archived).
 *   - A *merge* (`merged`, detail.into) forks toward the survivor lane.
 *   - PRUNED has no event and is therefore never invented here.
 *   - A draggable NOW cursor sits between rows; events at/after `now` render "future"
 *     (dimmed) — scrubbing drives the rest of the inspector via onNowChange / useSession.
 *   - Provenance episodes (GET /beliefs/{id}/provenance) expand inline per node, lazily.
 *
 * Self-contained: if `events` is not supplied it fetches the timeline itself. Imports only
 * from lib/* and components/primitives — does not touch any barrel/shared file.
 */

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, ChevronRight, GitBranch, Loader2, AlertTriangle } from "lucide-react";

import {
  api,
  ApiError,
  type BeliefEvent,
  type Episode,
} from "@/lib/api";
import {
  collapseSupersede,
  displayKind,
  isBranch,
  type EventKind,
} from "@/lib/events";
import {
  EVENT_COLOR,
  EVENT_GLYPH,
  EVENT_LABEL,
  fmtFloat,
} from "@/lib/tokens";
import { Mono, EmptyState } from "@/components/primitives";
import { useSession } from "@/components/SessionContext";

// ---------------------------------------------------------------------------
// props
// ---------------------------------------------------------------------------

export interface BeliefTimelineProps {
  /** The belief whose lifecycle to render. Used to fetch timeline + provenance. */
  beliefId: string;
  /**
   * Pre-fetched raw timeline (un-collapsed BeliefEvent[]). When omitted the component
   * fetches GET /beliefs/{id}/timeline itself. Pass this when a parent already holds it.
   */
  events?: BeliefEvent[];
  /**
   * The NOW time-cursor. When omitted the component reads/writes the global session now.
   * The cursor row drops between the events straddling this instant.
   */
  now?: Date;
  /** Called when the now-cursor is dragged. Falls back to session.setNow when omitted. */
  onNowChange?: (now: Date) => void;
  /** Currently-selected event id (for "state as of selected event"). */
  selectedEventId?: number | null;
  /** Selecting an event row (clicking its node) — drives the StateAsOfPane / DiffDrawer. */
  onSelectEvent?: (event: BeliefEvent) => void;
  /** Opening the before/after diff for a contradicted/superseded/merged row. */
  onOpenDiff?: (event: BeliefEvent) => void;
  className?: string;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const ROW_H = 76; // px per event row (rail metrics depend on this)
const RAIL_X = 18; // px x of the primary (trunk) rail
const FORK_X = 40; // px x of the forked (side) lane rail

function parseAt(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/** UTC machine timestamp, e.g. 2026-06-20 08:00 UTC. */
function fmtTs(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`
  );
}

/** The real BeliefEventTypeName under a display row (branch is shown via contradicted). */
function eventTypeOf(e: BeliefEvent) {
  return e.event_type;
}

/** Does this row open a fork in the gutter? branch | supersede | merge. */
function isFork(e: BeliefEvent): boolean {
  const kind = displayKind(e);
  return kind === "branch" || kind === "superseded" || kind === "merged";
}

/** The id of the counterpart belief a fork points at (by / into), if any. */
function forkTargetId(e: BeliefEvent): string | null {
  const d = e.detail ?? {};
  const by = d.by;
  const into = d.into;
  if (typeof into === "string") return into;
  if (typeof by === "string") return by;
  return null;
}

/** Human one-liner describing a row, kept truthful to detail.* fields. */
function describe(e: BeliefEvent): React.ReactNode {
  const kind = displayKind(e);
  const d = e.detail ?? {};
  switch (kind) {
    case "formed":
      return typeof d.statement === "string" ? (
        <span className="font-sans text-ink">&ldquo;{d.statement}&rdquo;</span>
      ) : (
        <Mono faint>belief formed</Mono>
      );
    case "reinforced": {
      const before = typeof d.from === "number" ? d.from : undefined;
      const after = typeof d.to === "number" ? d.to : undefined;
      const delta =
        typeof d.delta === "number"
          ? d.delta
          : before != null && after != null
            ? after - before
            : undefined;
      return (
        <Mono dim>
          {before != null && after != null ? (
            <>
              conf {fmtFloat(before)} &rarr; {fmtFloat(after)}
            </>
          ) : (
            "confidence reinforced"
          )}
          {delta != null ? (
            <span style={{ color: EVENT_COLOR.reinforced }}>
              {" "}
              &#9650; {delta >= 0 ? "+" : ""}
              {fmtFloat(delta)}
            </span>
          ) : null}
        </Mono>
      );
    }
    case "branch": {
      const by = typeof d.by === "string" ? d.by : null;
      return (
        <Mono dim>
          contradicted{" "}
          <span style={{ color: EVENT_COLOR.contradicted }}>
            detail.kind=branch
          </span>
          {by ? (
            <>
              {" "}
              &middot; by <Mono>{by}</Mono>
            </>
          ) : null}{" "}
          &middot; old &rarr; dormant
        </Mono>
      );
    }
    case "superseded": {
      const by = typeof d.by === "string" ? d.by : null;
      return (
        <Mono dim>
          contradicted + superseded{" "}
          <Mono faint>(de-duped)</Mono>
          {by ? (
            <>
              {" "}
              &middot; superseded_by &rarr; <Mono>{by}</Mono>
            </>
          ) : null}{" "}
          &middot; old &rarr; archived
        </Mono>
      );
    }
    case "merged": {
      const into = typeof d.into === "string" ? d.into : null;
      return (
        <Mono dim>
          merged{into ? <> into <Mono>{into}</Mono></> : null}
        </Mono>
      );
    }
    case "demoted": {
      const to = typeof d.to === "string" ? d.to : null;
      const score = typeof d.score === "number" ? d.score : null;
      return (
        <Mono dim>
          {to ? (
            <>
              active &rarr;{" "}
              <span style={{ color: EVENT_COLOR.demoted }}>{to}</span>
            </>
          ) : (
            "demoted"
          )}
          {score != null ? (
            <>
              {" "}
              &middot; score <Mono>{fmtFloat(score, 4)}</Mono>
            </>
          ) : null}
        </Mono>
      );
    }
    case "promoted": {
      const reason = typeof d.reason === "string" ? d.reason : "accessed";
      return (
        <Mono dim>
          dormant &rarr;{" "}
          <span style={{ color: EVENT_COLOR.promoted }}>active</span> &middot;{" "}
          reason=<Mono>{reason}</Mono>
        </Mono>
      );
    }
    case "pruned":
      return <Mono faint>pruned (tombstone — reconstructed via snapshot-diff)</Mono>;
    default:
      return <Mono faint>{EVENT_LABEL[eventTypeOf(e)]}</Mono>;
  }
}

/** Glyph for a display kind (branch reuses the contradicted glyph). */
function glyphFor(kind: EventKind): string {
  if (kind === "branch") return EVENT_GLYPH.contradicted;
  if (kind === "superseded") return EVENT_GLYPH.superseded;
  return EVENT_GLYPH[kind as keyof typeof EVENT_GLYPH] ?? "•";
}

/** Hue for a display kind. */
function colorFor(kind: EventKind): string {
  if (kind === "branch") return EVENT_COLOR.contradicted;
  return EVENT_COLOR[kind as keyof typeof EVENT_COLOR] ?? "#9AA3AF";
}

// ---------------------------------------------------------------------------
// provenance expander (lazy, per node)
// ---------------------------------------------------------------------------

function ProvenanceExpander({ beliefId }: { beliefId: string }) {
  const [open, setOpen] = React.useState(false);
  const [episodes, setEpisodes] = React.useState<Episode[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    if (episodes != null || loading) return;
    setLoading(true);
    setError(null);
    try {
      const eps = await api.provenance(beliefId);
      setEpisodes(eps);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [beliefId, episodes, loading]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) void load();
  };

  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={toggle}
        className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-ink-dim transition-colors hover:bg-surface-2 hover:text-ink"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Mono className="text-2xs uppercase tracking-wide">
          provenance
        </Mono>
        <Mono faint className="text-2xs">
          /beliefs/{beliefId}/provenance
        </Mono>
      </button>

      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.16, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="mt-1 space-y-1.5 border-l border-border pl-3">
              {loading ? (
                <Mono faint className="text-2xs inline-flex items-center gap-1">
                  <Loader2 size={11} className="animate-spin" /> loading episodes…
                </Mono>
              ) : error ? (
                <Mono className="text-2xs" style={{ color: EVENT_COLOR.contradicted }}>
                  {error}
                </Mono>
              ) : episodes && episodes.length > 0 ? (
                episodes.map((ep) => (
                  <div key={ep.id} className="rounded-sm bg-surface-0 px-2 py-1.5">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <Mono className="text-2xs" style={{ color: "#9B7FD8" }}>
                        {ep.id}
                      </Mono>
                      <Mono faint className="text-2xs">
                        {ep.source}/{ep.kind}
                      </Mono>
                    </div>
                    {typeof ep.payload?.text === "string" ? (
                      <p className="mt-0.5 font-sans text-xs text-ink-dim">
                        &ldquo;{ep.payload.text}&rdquo;
                      </p>
                    ) : Object.keys(ep.payload ?? {}).length > 0 ? (
                      <Mono faint className="text-2xs mt-0.5 block break-all">
                        {JSON.stringify(ep.payload)}
                      </Mono>
                    ) : null}
                    <Mono faint className="text-2xs mt-0.5 block">
                      occurred {fmtTs(ep.occurred_at)} &middot; ingested{" "}
                      {fmtTs(ep.ingested_at)}
                    </Mono>
                  </div>
                ))
              ) : (
                <Mono faint className="text-2xs">
                  no source episodes still present
                </Mono>
              )}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------------------
// the now-cursor row
// ---------------------------------------------------------------------------

function NowCursor({
  iso,
  onDrag,
  draggable,
}: {
  iso: string;
  onDrag?: (deltaY: number) => void;
  draggable: boolean;
}) {
  return (
    <div className="relative flex items-center" style={{ height: 28 }}>
      {/* trunk dot */}
      <div
        className="absolute"
        style={{ left: RAIL_X, transform: "translate(-50%, -50%)", top: "50%" }}
      >
        <span
          className="block rounded-full"
          style={{
            width: 10,
            height: 10,
            backgroundColor: "#4ED8C4",
            boxShadow: "0 0 0 3px rgba(78,216,196,0.25)",
          }}
        />
      </div>
      <motion.button
        type="button"
        aria-label="Drag the now time-cursor to scrub state"
        drag={draggable ? "y" : false}
        dragMomentum={false}
        dragElastic={0}
        onDrag={(_, info) => onDrag?.(info.delta.y)}
        whileDrag={{ scale: 1.0 }}
        className={`ml-12 flex items-center gap-2 rounded-full border px-2.5 py-0.5 ${
          draggable ? "cursor-ns-resize" : "cursor-default"
        }`}
        style={{
          borderColor: "#4ED8C455",
          backgroundColor: "#4ED8C414",
        }}
      >
        <Mono className="text-2xs uppercase tracking-wide" style={{ color: "#4ED8C4" }}>
          &#9678; now
        </Mono>
        <Mono className="text-2xs" style={{ color: "#4ED8C4" }}>
          {fmtTs(iso)}
        </Mono>
        {draggable ? (
          <Mono faint className="text-2xs">
            &#9664; drag to scrub
          </Mono>
        ) : null}
      </motion.button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// a single event node row
// ---------------------------------------------------------------------------

function EventNode({
  event,
  beliefId,
  future,
  selected,
  isFirst,
  isLast,
  onSelect,
  onOpenDiff,
}: {
  event: BeliefEvent;
  beliefId: string;
  future: boolean;
  selected: boolean;
  isFirst: boolean;
  isLast: boolean;
  onSelect?: (e: BeliefEvent) => void;
  onOpenDiff?: (e: BeliefEvent) => void;
}) {
  const kind = displayKind(event);
  const color = colorFor(kind);
  const glyph = glyphFor(kind);
  const fork = isFork(event);
  const target = forkTargetId(event);
  const opacity = future ? 0.4 : 1;

  return (
    <div
      className="relative flex"
      style={{ minHeight: ROW_H, opacity }}
    >
      {/* ---- the SVG rail / fork gutter ---- */}
      <svg
        width={56}
        height={ROW_H}
        className="absolute left-0 top-0"
        style={{ overflow: "visible" }}
        aria-hidden
      >
        {/* trunk line above the node (skip for the very first row) */}
        {!isFirst ? (
          <line
            x1={RAIL_X}
            y1={0}
            x2={RAIL_X}
            y2={ROW_H / 2}
            stroke="#2A2F38"
            strokeWidth={2}
          />
        ) : null}
        {/* trunk line below the node (skip for the very last row) */}
        {!isLast ? (
          <line
            x1={RAIL_X}
            y1={ROW_H / 2}
            x2={RAIL_X}
            y2={ROW_H}
            stroke="#2A2F38"
            strokeWidth={2}
          />
        ) : null}

        {/* fork gutter — a curve peeling off the trunk into the side lane */}
        {fork ? (
          <>
            <path
              d={`M ${RAIL_X} ${ROW_H / 2}
                  C ${RAIL_X} ${ROW_H * 0.78},
                    ${FORK_X} ${ROW_H * 0.62},
                    ${FORK_X} ${ROW_H}`}
              fill="none"
              stroke={color}
              strokeWidth={2}
              strokeDasharray={kind === "branch" ? "4 3" : undefined}
            />
            {/* small fork dot on the side lane */}
            <circle cx={FORK_X} cy={ROW_H} r={3} fill={color} />
          </>
        ) : null}

        {/* the node marker */}
        <circle
          cx={RAIL_X}
          cy={ROW_H / 2}
          r={selected ? 8 : 6}
          fill="#0A0B0D"
          stroke={color}
          strokeWidth={2}
        />
      </svg>

      {/* glyph centered over the node marker */}
      <div
        className="absolute"
        style={{
          left: RAIL_X,
          top: ROW_H / 2,
          transform: "translate(-50%, -50%)",
        }}
      >
        <Mono className="text-2xs leading-none" style={{ color }}>
          {glyph}
        </Mono>
      </div>

      {/* ---- the row body ---- */}
      <button
        type="button"
        onClick={() => onSelect?.(event)}
        className={`ml-16 flex-1 rounded-md border px-3 py-2 text-left transition-colors ${
          selected
            ? "bg-surface-2"
            : "border-transparent hover:border-border hover:bg-surface-1"
        }`}
        style={selected ? { borderColor: `${color}66` } : undefined}
      >
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {/* event verb chip */}
          <span
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5"
            style={{ backgroundColor: `${color}1A` }}
          >
            <Mono className="text-2xs" style={{ color }}>
              {glyph}
            </Mono>
            <Mono className="text-2xs lowercase" style={{ color }}>
              {kind === "branch" ? "branch" : EVENT_LABEL[eventTypeOf(event)]}
            </Mono>
          </span>

          <Mono dim className="text-2xs">
            {fmtTs(event.at)}
          </Mono>

          {future ? (
            <Mono faint className="text-2xs uppercase tracking-wide">
              future (after now)
            </Mono>
          ) : null}

          {fork && onOpenDiff ? (
            <span
              role="button"
              tabIndex={0}
              onClick={(ev) => {
                ev.stopPropagation();
                onOpenDiff(event);
              }}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" || ev.key === " ") {
                  ev.stopPropagation();
                  onOpenDiff(event);
                }
              }}
              className="ml-auto inline-flex cursor-pointer items-center gap-1 rounded border border-border px-1.5 py-0.5 text-ink-dim hover:bg-surface-2 hover:text-ink"
            >
              <GitBranch size={11} />
              <Mono className="text-2xs">open diff &#9656;</Mono>
            </span>
          ) : null}
        </div>

        <div className="mt-1 text-xs">{describe(event)}</div>

        {/* the forked counterpart belief — shown dim, on the side lane */}
        {fork && target ? (
          <div className="mt-1 flex items-center gap-1.5">
            <span
              className="inline-block rounded-full"
              style={{ width: 6, height: 6, backgroundColor: color }}
            />
            <Mono faint className="text-2xs">
              {kind === "merged" ? "into" : kind === "branch" ? "forked → kept as history" : "prior belief →"}{" "}
              <Mono dim>{target}</Mono>
            </Mono>
          </div>
        ) : null}

        {/* inline provenance — the formed row is where source episodes live */}
        {kind === "formed" ? <ProvenanceExpander beliefId={beliefId} /> : null}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// the timeline
// ---------------------------------------------------------------------------

export function BeliefTimeline({
  beliefId,
  events: eventsProp,
  now: nowProp,
  onNowChange,
  selectedEventId,
  onSelectEvent,
  onOpenDiff,
  className = "",
}: BeliefTimelineProps) {
  const session = useSession();
  const now = nowProp ?? session.now;
  const setNow = onNowChange ?? session.setNow;

  const [fetched, setFetched] = React.useState<BeliefEvent[] | null>(
    eventsProp ?? null,
  );
  const [loading, setLoading] = React.useState(eventsProp == null);
  const [error, setError] = React.useState<string | null>(null);

  // fetch when no events were supplied (and re-fetch if beliefId changes)
  React.useEffect(() => {
    if (eventsProp != null) {
      setFetched(eventsProp);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .timeline(beliefId)
      .then((t) => {
        if (!cancelled) setFetched(t);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof ApiError ? e.message : (e as Error).message);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [beliefId, eventsProp]);

  // collapse supersede pairs + sort chronologically (oldest first → trunk grows down)
  const rows = React.useMemo(() => {
    const raw = fetched ?? [];
    const collapsed = collapseSupersede(raw.map((e) => ({ ...e, detail: { ...e.detail } })));
    return [...collapsed].sort((a, b) => parseAt(a.at) - parseAt(b.at));
  }, [fetched]);

  const nowMs = now.getTime();
  const nowIso = now.toISOString();

  // index of the first row that is at/after `now` — the cursor drops just above it
  const cursorIndex = React.useMemo(() => {
    for (let i = 0; i < rows.length; i++) {
      if (parseAt(rows[i].at) > nowMs) return i;
    }
    return rows.length;
  }, [rows, nowMs]);

  // dragging the cursor moves `now` between adjacent event instants
  const handleDrag = React.useCallback(
    (deltaY: number) => {
      if (rows.length === 0) return;
      // map vertical drag to a step across event boundaries
      const step = Math.round(deltaY / (ROW_H / 2));
      if (step === 0) return;
      const target = Math.min(
        rows.length,
        Math.max(0, cursorIndex + step),
      );
      // place `now` midway between the straddling events
      const prev = target > 0 ? parseAt(rows[target - 1].at) : null;
      const next = target < rows.length ? parseAt(rows[target].at) : null;
      let ms: number;
      if (prev != null && next != null) ms = Math.floor((prev + next) / 2);
      else if (prev != null) ms = prev + 60_000;
      else if (next != null) ms = next - 60_000;
      else return;
      setNow(new Date(ms));
    },
    [rows, cursorIndex, setNow],
  );

  // ---- states ----

  if (loading) {
    return (
      <div className={className}>
        <TimelineHeader />
        <div className="flex items-center gap-2 px-4 py-10">
          <Loader2 size={16} className="animate-spin text-accent" />
          <Mono faint className="text-xs">
            loading lifecycle… GET /beliefs/{beliefId}/timeline
          </Mono>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={className}>
        <TimelineHeader />
        <EmptyState
          icon={AlertTriangle}
          tone="error"
          title="Could not load this belief's timeline"
          detail={error}
        />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className={className}>
        <TimelineHeader />
        <EmptyState
          icon={GitBranch}
          title="No lifecycle events"
          detail="This belief has no recorded transitions yet — it may have been formed but never reinforced, contradicted, or maintained."
        />
      </div>
    );
  }

  return (
    <div className={className}>
      <TimelineHeader />

      <div className="relative pl-2 pr-1">
        {rows.map((event, i) => (
          <React.Fragment key={event.id ?? `${event.event_type}-${event.at}-${i}`}>
            {i === cursorIndex ? (
              <NowCursor iso={nowIso} onDrag={handleDrag} draggable />
            ) : null}
            <EventNode
              event={event}
              beliefId={beliefId}
              future={parseAt(event.at) > nowMs}
              selected={selectedEventId != null && event.id === selectedEventId}
              isFirst={i === 0}
              isLast={i === rows.length - 1}
              onSelect={onSelectEvent}
              onOpenDiff={onOpenDiff}
            />
          </React.Fragment>
        ))}
        {/* cursor after the last row (now is in the future of all events) */}
        {cursorIndex === rows.length ? (
          <NowCursor iso={nowIso} onDrag={handleDrag} draggable />
        ) : null}
      </div>

      {/* honest filter / legend footer (matches the inspector mockup) */}
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-2 pt-2">
        <Mono faint className="text-2xs uppercase tracking-wide">
          lanes
        </Mono>
        <LegendDot color={EVENT_COLOR.formed} label="trunk" />
        <LegendDot color={EVENT_COLOR.contradicted} label="branch / supersede fork" />
        <LegendDot color={EVENT_COLOR.merged} label="merge fork" />
        <Mono faint className="text-2xs">
          supersede = contradicted+superseded, de-duped to one row
        </Mono>
        <Mono faint className="text-2xs">
          pruned has no event &middot; tombstone via snapshot-diff only
        </Mono>
      </div>
    </div>
  );
}

function TimelineHeader() {
  return (
    <div className="flex items-center justify-between border-b border-border px-2 pb-2">
      <Mono dim className="text-xs uppercase tracking-wide">
        Lifecycle timeline
      </Mono>
      <Mono faint className="text-2xs">
        GET /beliefs/&#123;id&#125;/timeline
      </Mono>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className="inline-block rounded-full"
        style={{ width: 6, height: 6, backgroundColor: color }}
      />
      <Mono faint className="text-2xs">
        {label}
      </Mono>
    </span>
  );
}

export default BeliefTimeline;
