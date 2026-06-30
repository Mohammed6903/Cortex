"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { ArrowRight, GitBranch, GitMerge, Replace } from "lucide-react";

import { api, type Belief, type BeliefEvent } from "@/lib/api";
import { isBranch, displayKind } from "@/lib/events";
import {
  EVENT_COLOR,
  TYPE_LABEL,
  fmtFloat,
  opacityFromConfidence,
  weightFromConfidence,
} from "@/lib/tokens";
import { Badge, Drawer, EmptyState, Meter, Mono } from "@/components/primitives";

/**
 * DiffDrawer — before/after reconciliation panel for the three "two-belief" events:
 * a supersede, a branch, or a merge. Slides in (the Drawer primitive unfolds 160ms
 * ease-out; reduced-motion is honored globally).
 *
 * Honesty grammar (non-negotiable, from cortex/store/beliefs.py):
 *   - There is NO `branched` event. A BRANCH is a `contradicted` event with
 *     detail.kind === "branch"; the old belief is demoted to DORMANT and kept.
 *   - A SUPERSEDE emits BOTH `contradicted` AND `superseded` for one act — the timeline
 *     is collapsed upstream (lib/events.collapseSupersede) to a single `superseded` row,
 *     so this drawer only ever sees the surviving event. The old belief is ARCHIVED.
 *   - A MERGE emits `merged` with detail.into === survivorId; the loser is folded in.
 *
 * The "before" belief is the one whose timeline produced this event (the old / loser).
 * The "after" belief is the one named in event.detail (`by` for contradicted/superseded,
 * `into` for merged). If `after` is not supplied it is fetched by id from the live scratch
 * session. The reconciliation reason is read verbatim from event.detail — never invented.
 */

export interface DiffDrawerProps {
  open: boolean;
  onClose: () => void;
  /** The contradicted/superseded/merged event being inspected (post-collapse). */
  event: BeliefEvent | null;
  /** The belief this timeline belongs to — the BEFORE side (old / loser). */
  before: Belief;
  /**
   * The AFTER belief (the new/surviving belief named in event.detail). If omitted, it is
   * fetched by id; pass it when you already have it to skip the round-trip.
   */
  after?: Belief | null;
}

/** Pull the referenced counterpart belief id out of an event's detail, honestly. */
function counterpartId(event: BeliefEvent): string | null {
  const d = event.detail ?? {};
  const by = d.by;
  const into = d.into;
  if (typeof into === "string") return into; // merged
  if (typeof by === "string") return by; // contradicted / superseded
  return null;
}

/** The human reason carried in detail, if any — read verbatim, label what it is. */
function reconciliationReason(event: BeliefEvent): {
  label: string;
  value: string | null;
} {
  const d = event.detail ?? {};
  for (const key of ["reason", "rationale", "explanation", "note"]) {
    const v = d[key];
    if (typeof v === "string" && v.trim()) return { label: key, value: v };
  }
  return { label: "reason", value: null };
}

function fmtTs(ts: string | null): string {
  if (!ts) return "—";
  // keep machine truth: trim to minute precision, UTC, no locale magic.
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

function validityWindow(b: Belief): string {
  const start = fmtTs(b.validity_start);
  const end = b.validity_end ? fmtTs(b.validity_end) : "open";
  return `${start} → ${end}`;
}

/** Title + glyph + the post-collapse display kind for the header. */
function diffMeta(event: BeliefEvent): {
  kind: "branch" | "superseded" | "merged";
  title: string;
  Icon: typeof GitBranch;
  color: string;
} {
  if (isBranch(event)) {
    return {
      kind: "branch",
      title: "diff · branch",
      Icon: GitBranch,
      color: EVENT_COLOR.contradicted,
    };
  }
  if (event.event_type === "merged") {
    return {
      kind: "merged",
      title: "diff · merge",
      Icon: GitMerge,
      color: EVENT_COLOR.merged,
    };
  }
  // superseded (or a lone contradicted shown supersede-like)
  return {
    kind: "superseded",
    title: "diff · supersede",
    Icon: Replace,
    color: EVENT_COLOR.superseded,
  };
}

/** One side of the diff — a belief card with statement, conf/sal meters, validity. */
function BeliefSide({
  belief,
  role,
  faded = false,
}: {
  belief: Belief;
  role: "before" | "after";
  faded?: boolean;
}) {
  const opacity = opacityFromConfidence(belief.confidence);
  const weight = weightFromConfidence(belief.confidence);
  return (
    <div
      className="rounded-md border border-border bg-surface-0 p-3"
      style={faded ? { opacity: 0.78 } : undefined}
    >
      <div className="mb-2 flex items-center justify-between">
        <Mono dim className="text-2xs uppercase tracking-wide">
          {role}
        </Mono>
        <Badge variant="tier" value={belief.tier} />
      </div>

      {/* statement — Inter prose, weighted + faded by confidence */}
      <p
        className="font-sans text-sm leading-snug text-ink"
        style={{ opacity, fontWeight: weight }}
      >
        {belief.statement}
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <Mono faint className="text-2xs">
          {belief.id}
        </Mono>
        <Badge variant="type" value={belief.type} />
      </div>

      <div className="mt-3 space-y-1.5">
        <Meter
          value={belief.confidence}
          label="conf"
          color="#4ED8C4"
          width={120}
        />
        <Meter
          value={belief.salience}
          label="sal"
          color="#9AA3AF"
          width={120}
        />
      </div>

      <div className="mt-3 border-t border-border pt-2">
        <Mono dim className="text-2xs uppercase tracking-wide">
          validity
        </Mono>
        <div>
          <Mono className="text-2xs">{validityWindow(belief)}</Mono>
        </div>
      </div>
    </div>
  );
}

/** A single before→after field delta row (used for confidence). */
function DeltaRow({
  label,
  beforeVal,
  afterVal,
}: {
  label: string;
  beforeVal: number;
  afterVal: number;
}) {
  const delta = afterVal - beforeVal;
  const sign = delta > 0 ? "+" : "";
  const color =
    delta > 0 ? EVENT_COLOR.reinforced : delta < 0 ? EVENT_COLOR.contradicted : "#9AA3AF";
  return (
    <div className="flex items-center justify-between gap-2">
      <Mono dim className="text-2xs uppercase tracking-wide">
        {label}
      </Mono>
      <span className="flex items-center gap-1.5">
        <Mono className="text-2xs">{fmtFloat(beforeVal)}</Mono>
        <ArrowRight size={11} className="text-ink-faint" aria-hidden />
        <Mono className="text-2xs">{fmtFloat(afterVal)}</Mono>
        {delta !== 0 ? (
          <Mono className="text-2xs" style={{ color }}>
            ({sign}
            {fmtFloat(delta)})
          </Mono>
        ) : null}
      </span>
    </div>
  );
}

export function DiffDrawer({
  open,
  onClose,
  event,
  before,
  after: afterProp,
}: DiffDrawerProps) {
  const [after, setAfter] = React.useState<Belief | null>(afterProp ?? null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const wantedId = event ? counterpartId(event) : null;

  React.useEffect(() => {
    setAfter(afterProp ?? null);
  }, [afterProp]);

  React.useEffect(() => {
    if (!open || !wantedId) return;
    // already have the right belief (prop or prior fetch)? skip.
    if (after && after.id === wantedId) return;

    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .belief(wantedId)
      .then((b) => {
        if (!cancelled) setAfter(b);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // intentionally keyed on open + wantedId; `after` is read but not a trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, wantedId]);

  const meta = event ? diffMeta(event) : null;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={500}
      title={meta ? meta.title : "diff"}
    >
      {!event || !meta ? (
        <EmptyState
          title="No reconciliation event selected"
          detail="Pick a contradicted, superseded, or merged node to compare before / after."
        />
      ) : (
        <div className="space-y-4">
          {/* header — event glyph + kind, instant */}
          <div className="flex items-center gap-2">
            <meta.Icon size={16} style={{ color: meta.color }} aria-hidden />
            <Badge variant="event" value={event.event_type} />
            {isBranch(event) ? (
              <Mono dim className="text-2xs">
                kind=branch
              </Mono>
            ) : null}
            <span className="ml-auto">
              <Mono faint className="text-2xs">
                {fmtTs(event.at)}
              </Mono>
            </span>
          </div>

          {/* a one-line plain statement of what happened, honest per kind */}
          <p className="font-sans text-xs leading-relaxed text-ink-dim">
            {meta.kind === "branch" ? (
              <>
                Preference change kept as history — the prior belief was{" "}
                <Mono className="text-2xs" style={{ color: "#E0A458" }}>
                  demoted to dormant
                </Mono>{" "}
                (a branch, not a delete) and a new belief was formed.
              </>
            ) : meta.kind === "superseded" ? (
              <>
                Fact correction — the prior belief was{" "}
                <Mono className="text-2xs" style={{ color: "#5B6470" }}>
                  archived
                </Mono>{" "}
                with{" "}
                <Mono className="text-2xs">superseded_by</Mono> set, replaced by the
                belief below.{" "}
                <Mono faint className="text-2xs">
                  (contradicted + superseded collapsed to one row)
                </Mono>
              </>
            ) : (
              <>
                Two beliefs were{" "}
                <Mono className="text-2xs" style={{ color: "#9B7FD8" }}>
                  merged
                </Mono>{" "}
                — the one below was kept as the survivor and the other folded into it.
              </>
            )}
          </p>

          {/* before / after stack with a connecting arrow */}
          <div className="space-y-2">
            <BeliefSide belief={before} role="before" faded />

            <div className="flex items-center justify-center py-0.5">
              <motion.span
                initial={{ y: -4, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ duration: 0.16, ease: "easeOut", delay: 0.04 }}
              >
                <ArrowRight
                  size={16}
                  className="rotate-90"
                  style={{ color: meta.color }}
                  aria-label="becomes"
                />
              </motion.span>
            </div>

            {after ? (
              <BeliefSide belief={after} role="after" />
            ) : loading ? (
              <EmptyState
                tone="loading"
                title="Loading the counterpart belief…"
                detail={wantedId ?? undefined}
              />
            ) : error ? (
              <EmptyState
                tone="error"
                title="Could not load the counterpart belief"
                detail={error}
              />
            ) : (
              <EmptyState
                title="No counterpart belief recorded"
                detail={
                  <>
                    This event&apos;s <Mono className="text-2xs">detail</Mono> names no{" "}
                    <Mono className="text-2xs">
                      {meta.kind === "merged" ? "into" : "by"}
                    </Mono>{" "}
                    target.
                  </>
                }
              />
            )}
          </div>

          {/* field deltas — only meaningful when both sides resolved */}
          {after ? (
            <div className="rounded-md border border-border bg-surface-1 p-3">
              <Mono dim className="mb-2 block text-2xs uppercase tracking-wide">
                deltas (before → after)
              </Mono>
              <div className="space-y-1.5">
                <DeltaRow
                  label="confidence"
                  beforeVal={before.confidence}
                  afterVal={after.confidence}
                />
                <DeltaRow
                  label="salience"
                  beforeVal={before.salience}
                  afterVal={after.salience}
                />
                <div className="flex items-center justify-between gap-2">
                  <Mono dim className="text-2xs uppercase tracking-wide">
                    type
                  </Mono>
                  <span className="flex items-center gap-1.5">
                    <Mono className="text-2xs">{TYPE_LABEL[before.type]}</Mono>
                    <ArrowRight size={11} className="text-ink-faint" aria-hidden />
                    <Mono className="text-2xs">{TYPE_LABEL[after.type]}</Mono>
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <Mono dim className="text-2xs uppercase tracking-wide">
                    validity
                  </Mono>
                  <span className="flex items-center gap-1.5">
                    <Mono faint className="text-2xs">
                      {fmtTs(before.validity_end)}
                    </Mono>
                    <ArrowRight size={11} className="text-ink-faint" aria-hidden />
                    <Mono className="text-2xs">
                      {after.validity_end ? fmtTs(after.validity_end) : "open"}
                    </Mono>
                  </span>
                </div>
              </div>
            </div>
          ) : null}

          {/* reconciliation reason — verbatim from detail, labeled as such */}
          <div className="rounded-md border border-border bg-surface-1 p-3">
            <Mono dim className="mb-1.5 block text-2xs uppercase tracking-wide">
              reconciliation reason
            </Mono>
            {(() => {
              const { label, value } = reconciliationReason(event);
              if (value) {
                return (
                  <>
                    <p className="font-sans text-xs leading-relaxed text-ink">
                      {value}
                    </p>
                    <Mono faint className="mt-1 block text-2xs">
                      from event.detail.{label}
                    </Mono>
                  </>
                );
              }
              return (
                <Mono faint className="text-2xs">
                  no reason recorded in event.detail — the engine reconciled this{" "}
                  {displayKind(event)} structurally (no free-text rationale stored).
                </Mono>
              );
            })()}
          </div>

          {/* raw detail — full machine truth, never hidden */}
          <details className="rounded-md border border-border bg-surface-0 p-3">
            <summary className="cursor-pointer select-none">
              <Mono dim className="text-2xs uppercase tracking-wide">
                raw event.detail
              </Mono>
            </summary>
            <pre className="mt-2 overflow-x-auto">
              <Mono faint className="text-2xs leading-relaxed">
                {JSON.stringify(event.detail ?? {}, null, 2)}
              </Mono>
            </pre>
          </details>
        </div>
      )}
    </Drawer>
  );
}

export default DiffDrawer;
