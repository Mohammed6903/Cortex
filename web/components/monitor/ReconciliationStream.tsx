"use client";

/**
 * ReconciliationStream — the verb-led activity feed of the Mind Monitor.
 *
 * It renders, newest-first, what the engine actually DID over the scratch session: one
 * row per reconciliation act, stitched from the POST responses the UI already collected:
 *
 *   - a LEARN run  → POST /learn   { results: LearnResult[] }   (actions: formed |
 *                    reinforced | superseded | branched)
 *   - a MAINTAIN run → POST /maintain { merged, demoted, pruned } — given its own
 *                    divider header ("── maintain HH:MM ──"), matching the hero mockup.
 *
 * Honesty constraints enforced at the render layer (see docs + lib/events):
 *   - There is NO `branched` *event* type. /learn DOES return a `branched` *action*; we
 *     surface it as a `contradicted` row carrying detail.kind="branch" — the same shape
 *     lib/events.isBranch reads — never as a fictional "branched" event.
 *   - A *supersede* emits BOTH `contradicted` AND `superseded` for one act. /learn already
 *     collapses that to a single `superseded` action; if a caller instead feeds raw
 *     per-belief timeline events (via `timelines`), collapseSupersede() de-dupes them so a
 *     supersede is still ONE row. We never emit two rows for one supersede.
 *   - PRUNED has no event — it is only ever known by snapshot-diffing /beliefs?all=true
 *     across a maintain. The MaintainResponse.pruned ids ARE that diff; rendered as
 *     tombstone (outline-only) rows. We never invent a pruned event.
 *
 * Presentational by contract: all data arrives via props. `beliefs` is an optional id→Belief
 * lookup used purely to show the human statement next to a machine id; `timelines` is an
 * optional id→raw-BeliefEvent[] map used to enrich a row with the real before/after floats
 * and detail.* fields the bare POST response omits. Both are best-effort — every row degrades
 * gracefully to ids when a lookup is missing. Imports only from lib/* and primitives.
 */

import * as React from "react";
import { motion } from "framer-motion";
import { Radio } from "lucide-react";

import type {
  Belief,
  BeliefEvent,
  LearnResult,
  MaintainResponse,
} from "@/lib/api";
import { collapseSupersede } from "@/lib/events";
import {
  EVENT_COLOR,
  EVENT_GLYPH,
  EVENT_LABEL,
  fmtFloat,
} from "@/lib/tokens";
import { Mono, EmptyState } from "@/components/primitives";

// ---------------------------------------------------------------------------
// public types
// ---------------------------------------------------------------------------

/** One reconciliation pass, tagged by which POST produced it. `at` is the run instant. */
export type StreamRun =
  | {
      kind: "learn";
      /** ISO instant the run was issued at (or its `now`). Drives ordering + the row clock. */
      at: string;
      /** POST /learn response payload (results only). */
      results: LearnResult[];
    }
  | {
      kind: "maintain";
      at: string;
      /** POST /maintain response payload. `pruned` is the snapshot-diff result. */
      response: MaintainResponse;
    };

export interface ReconciliationStreamProps {
  /** Newest-or-any-order runs; the component sorts them newest-first internally. */
  runs: StreamRun[];
  /** Optional id→Belief lookup, to show statements beside machine ids. Best-effort. */
  beliefs?: Record<string, Belief>;
  /** Optional id→raw timeline (un-collapsed BeliefEvent[]) to enrich rows with real floats. */
  timelines?: Record<string, BeliefEvent[]>;
  /** Whether the stream is bound to the live scratch session (shows the ⟲ live tag). */
  live?: boolean;
  /** Scenario label, e.g. "scratch·02_branch", shown in the header. */
  scenario?: string | null;
  /** Click a belief-bearing row to jump to its inspector. */
  onSelectBelief?: (beliefId: string) => void;
  className?: string;
}

// ---------------------------------------------------------------------------
// the normalized display row
// ---------------------------------------------------------------------------

/** The honest set of verbs the stream can show (branch is explicit; supersede de-duped). */
type RowVerb =
  | "formed"
  | "reinforced"
  | "branch"
  | "superseded"
  | "merged"
  | "demoted"
  | "pruned";

interface DisplayRow {
  key: string;
  /** which run this row belongs to (for the maintain divider grouping). */
  runId: string;
  verb: RowVerb;
  /** ISO instant of the act (the run's `at`). */
  at: string;
  /** the primary belief this act is about, if any. */
  beliefId: string | null;
  /** counterpart belief (← prior on branch/supersede, → survivor on merge). */
  counterpartId: string | null;
  /** enrichment line under the headline, already truthful to detail.*. */
  detail: React.ReactNode;
}

// ---------------------------------------------------------------------------
// formatting helpers
// ---------------------------------------------------------------------------

function clockOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** Map an event-verb hue + glyph for a display verb (branch reuses contradicted). */
function verbColor(verb: RowVerb): string {
  if (verb === "branch") return EVENT_COLOR.contradicted;
  return EVENT_COLOR[verb] ?? "#9AA3AF";
}

function verbGlyph(verb: RowVerb): string {
  if (verb === "branch") return EVENT_GLYPH.contradicted;
  return EVENT_GLYPH[verb] ?? "•";
}

function verbLabel(verb: RowVerb): string {
  if (verb === "branch") return "contradicted";
  return EVENT_LABEL[verb] ?? verb;
}

function statementOf(
  beliefs: Record<string, Belief> | undefined,
  id: string | null,
): string | null {
  if (!id || !beliefs) return null;
  return beliefs[id]?.statement ?? null;
}

/**
 * Find the real BeliefEvent that backs a learn-result action for a belief, by scanning
 * its (collapsed) timeline for the matching verb. Lets us recover before/after floats and
 * detail.* the bare POST response omits. Returns null when no timeline was supplied.
 */
function backingEvent(
  timelines: Record<string, BeliefEvent[]> | undefined,
  beliefId: string | null,
  want: RowVerb,
): BeliefEvent | null {
  if (!timelines || !beliefId) return null;
  const raw = timelines[beliefId];
  if (!raw) return null;
  const collapsed = collapseSupersede(raw.map((e) => ({ ...e, detail: { ...e.detail } })));
  // newest matching first — a single belief can be reinforced repeatedly.
  const matches = collapsed.filter((e) => {
    if (want === "branch") {
      return e.event_type === "contradicted" && e.detail?.kind === "branch";
    }
    if (want === "superseded") return e.event_type === "superseded";
    return e.event_type === want;
  });
  if (matches.length === 0) return null;
  return matches.reduce((a, b) => (Date.parse(b.at) >= Date.parse(a.at) ? b : a));
}

// ---------------------------------------------------------------------------
// per-verb detail line builders (truthful to detail.* when present)
// ---------------------------------------------------------------------------

function formedDetail(ev: BeliefEvent | null): React.ReactNode {
  const conf = ev && typeof ev.detail?.confidence === "number" ? ev.detail.confidence : null;
  return (
    <Mono dim className="text-2xs">
      belief formed
      {conf != null ? (
        <>
          {" "}
          &middot; c<span style={{ color: EVENT_COLOR.formed }}>{fmtFloat(conf)}</span>
        </>
      ) : null}
    </Mono>
  );
}

function reinforcedDetail(ev: BeliefEvent | null): React.ReactNode {
  const from = ev && typeof ev.detail?.from === "number" ? ev.detail.from : null;
  const to = ev && typeof ev.detail?.to === "number" ? ev.detail.to : null;
  const delta =
    ev && typeof ev.detail?.delta === "number"
      ? ev.detail.delta
      : from != null && to != null
        ? to - from
        : null;
  return (
    <Mono dim className="text-2xs">
      {from != null && to != null ? (
        <>
          confidence {fmtFloat(from)} &rarr; {fmtFloat(to)}
        </>
      ) : (
        "confidence reinforced"
      )}
      {delta != null ? (
        <span style={{ color: EVENT_COLOR.reinforced }}>
          {"  "}
          ({delta >= 0 ? "+" : ""}
          {fmtFloat(delta)})
        </span>
      ) : null}
    </Mono>
  );
}

function branchDetail(priorStatement: string | null, priorId: string | null): React.ReactNode {
  return (
    <Mono dim className="text-2xs">
      <span style={{ color: EVENT_COLOR.contradicted }}>kind=branch</span> &middot; old
      &rarr; dormant &middot; validity closed &middot; superseded_by set
      {priorId ? (
        <>
          {" "}
          &middot; &larr;{" "}
          {priorStatement ? (
            <span className="font-sans text-ink-dim">{priorStatement}</span>
          ) : (
            <Mono faint>{priorId}</Mono>
          )}
        </>
      ) : null}
    </Mono>
  );
}

function supersedeDetail(
  priorStatement: string | null,
  priorId: string | null,
): React.ReactNode {
  return (
    <Mono dim className="text-2xs">
      contradicted + superseded <Mono faint>(de-duped to one row)</Mono> &middot; old &rarr;
      archived
      {priorId ? (
        <>
          {" "}
          &middot; superseded_by &rarr; <Mono faint>{priorId}</Mono>
        </>
      ) : null}
    </Mono>
  );
}

function mergedDetail(survivorId: string | null): React.ReactNode {
  return (
    <Mono dim className="text-2xs">
      merged
      {survivorId ? (
        <>
          {" "}
          &middot; into <Mono faint>{survivorId}</Mono>
        </>
      ) : null}{" "}
      &middot; loser folded into survivor
    </Mono>
  );
}

function demotedDetail(toTier: string, ev: BeliefEvent | null): React.ReactNode {
  const score = ev && typeof ev.detail?.score === "number" ? ev.detail.score : null;
  const floor = toTier === "dormant" ? "0.35 active floor" : "0.15 dormant floor";
  return (
    <Mono dim className="text-2xs">
      <span style={{ color: EVENT_COLOR.demoted }}>{toTier === "dormant" ? "active" : "dormant"} &rarr; {toTier}</span>
      {score != null ? (
        <>
          {" "}
          &middot; retention <Mono>{fmtFloat(score)}</Mono>{" "}
          <Mono faint>(&lt; {floor})</Mono>
        </>
      ) : (
        <>
          {" "}
          <Mono faint>(&lt; {floor})</Mono>
        </>
      )}
    </Mono>
  );
}

function prunedDetail(): React.ReactNode {
  return (
    <Mono faint className="text-2xs">
      hard-deleted &middot; tombstone reconstructed via snapshot-diff (no event exists)
    </Mono>
  );
}

// ---------------------------------------------------------------------------
// run → display rows
// ---------------------------------------------------------------------------

/** Normalize a learn-result action into our honest display verb. */
function verbOfAction(action: LearnResult["action"]): RowVerb {
  if (action === "branched") return "branch";
  if (action === "superseded") return "superseded";
  if (action === "reinforced") return "reinforced";
  return "formed";
}

function learnRows(
  run: Extract<StreamRun, { kind: "learn" }>,
  runId: string,
  beliefs: Record<string, Belief> | undefined,
  timelines: Record<string, BeliefEvent[]> | undefined,
): DisplayRow[] {
  return run.results.map((r, i) => {
    const verb = verbOfAction(r.action);
    const ev = backingEvent(timelines, r.belief_id, verb);
    const priorStatement = statementOf(beliefs, r.prior_id);
    let detail: React.ReactNode;
    switch (verb) {
      case "formed":
        detail = formedDetail(ev);
        break;
      case "reinforced":
        detail = reinforcedDetail(ev);
        break;
      case "branch":
        detail = branchDetail(priorStatement, r.prior_id);
        break;
      case "superseded":
        detail = supersedeDetail(priorStatement, r.prior_id);
        break;
      default:
        detail = null;
    }
    return {
      key: `${runId}:learn:${i}:${r.belief_id}`,
      runId,
      verb,
      at: run.at,
      beliefId: r.belief_id,
      counterpartId: r.prior_id,
      detail,
    };
  });
}

function maintainRows(
  run: Extract<StreamRun, { kind: "maintain" }>,
  runId: string,
  timelines: Record<string, BeliefEvent[]> | undefined,
): DisplayRow[] {
  const out: DisplayRow[] = [];
  const { merged, demoted, pruned } = run.response;

  merged.forEach(([loserId, survivorId], i) => {
    out.push({
      key: `${runId}:merged:${i}:${loserId}`,
      runId,
      verb: "merged",
      at: run.at,
      beliefId: loserId,
      counterpartId: survivorId,
      detail: mergedDetail(survivorId),
    });
  });

  demoted.forEach(([beliefId, toTier], i) => {
    const ev = backingEvent(timelines, beliefId, "demoted");
    out.push({
      key: `${runId}:demoted:${i}:${beliefId}`,
      runId,
      verb: "demoted",
      at: run.at,
      beliefId,
      counterpartId: null,
      detail: demotedDetail(toTier, ev),
    });
  });

  pruned.forEach((beliefId, i) => {
    out.push({
      key: `${runId}:pruned:${i}:${beliefId}`,
      runId,
      verb: "pruned",
      at: run.at,
      beliefId,
      counterpartId: null,
      detail: prunedDetail(),
    });
  });

  return out;
}

// ---------------------------------------------------------------------------
// a single stream row
// ---------------------------------------------------------------------------

function StreamRow({
  row,
  beliefs,
  onSelectBelief,
}: {
  row: DisplayRow;
  beliefs?: Record<string, Belief>;
  onSelectBelief?: (id: string) => void;
}) {
  const color = verbColor(row.verb);
  const glyph = verbGlyph(row.verb);
  const label = verbLabel(row.verb);
  const isPruned = row.verb === "pruned";
  const statement = statementOf(beliefs, row.beliefId);
  const clickable = row.beliefId != null && onSelectBelief != null;

  const body = (
    <>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <Mono faint className="text-2xs">
          {clockOf(row.at)}
        </Mono>
        <span
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5"
          style={{ backgroundColor: isPruned ? "transparent" : `${color}1A` }}
        >
          <Mono className="text-2xs leading-none" style={{ color }}>
            {glyph}
          </Mono>
          <Mono className="text-2xs lowercase" style={{ color }}>
            {label}
          </Mono>
          {row.verb === "branch" ? (
            <Mono faint className="text-2xs">
              (branch)
            </Mono>
          ) : null}
        </span>

        {statement ? (
          <span
            className={`font-sans text-xs ${isPruned ? "text-ink-faint line-through" : "text-ink"}`}
          >
            &ldquo;{statement}&rdquo;
          </span>
        ) : row.beliefId ? (
          <Mono dim className="text-2xs">
            {row.beliefId}
          </Mono>
        ) : null}
      </div>

      <div className="mt-0.5 pl-1">{row.detail}</div>
    </>
  );

  const base =
    "block w-full rounded-md border px-2.5 py-1.5 text-left transition-colors";
  const tone = isPruned
    ? "border-dashed"
    : "border-transparent hover:border-border hover:bg-surface-1";

  if (clickable) {
    return (
      <motion.button
        type="button"
        layout
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.16, ease: "easeOut" }}
        onClick={() => onSelectBelief!(row.beliefId!)}
        className={`${base} ${tone}`}
        style={isPruned ? { borderColor: "#2A2F38" } : undefined}
      >
        {body}
      </motion.button>
    );
  }

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.16, ease: "easeOut" }}
      className={`${base} ${tone} cursor-default`}
      style={isPruned ? { borderColor: "#2A2F38" } : undefined}
    >
      {body}
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// the maintain divider header
// ---------------------------------------------------------------------------

function MaintainDivider({ at }: { at: string }) {
  return (
    <div className="flex items-center gap-2 py-1.5">
      <span className="h-px flex-1" style={{ backgroundColor: "#2A2F38" }} />
      <Mono faint className="text-2xs uppercase tracking-wide">
        maintain {clockOf(at)}
      </Mono>
      <span className="h-px flex-1" style={{ backgroundColor: "#2A2F38" }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// the stream
// ---------------------------------------------------------------------------

export function ReconciliationStream({
  runs,
  beliefs,
  timelines,
  live = false,
  scenario,
  onSelectBelief,
  className = "",
}: ReconciliationStreamProps) {
  // Sort newest-first, but keep a stable run id so a maintain's rows stay grouped.
  const ordered = React.useMemo(() => {
    const indexed = runs.map((run, i) => ({ run, runId: `run-${i}-${run.at}` }));
    return [...indexed].sort(
      (a, b) => Date.parse(b.run.at) - Date.parse(a.run.at),
    );
  }, [runs]);

  return (
    <div className={className}>
      <Header live={live} scenario={scenario} />

      {ordered.length === 0 ? (
        <EmptyState
          icon={Radio}
          title="No reconciliation activity yet"
          detail="Run learn or maintain against the scratch session — formed / reinforced / branch / supersede / demote / merge / prune acts land here verb-first, newest at the top."
        />
      ) : (
        <div className="space-y-0.5">
          {ordered.map(({ run, runId }) => {
            if (run.kind === "maintain") {
              const rows = maintainRows(run, runId, timelines);
              return (
                <div key={runId}>
                  <MaintainDivider at={run.at} />
                  {rows.length === 0 ? (
                    <Mono faint className="block px-2.5 py-1.5 text-2xs">
                      maintain ran &middot; no demotions, merges, or prunes
                    </Mono>
                  ) : (
                    rows.map((row) => (
                      <StreamRow
                        key={row.key}
                        row={row}
                        beliefs={beliefs}
                        onSelectBelief={onSelectBelief}
                      />
                    ))
                  )}
                </div>
              );
            }
            const rows = learnRows(run, runId, beliefs, timelines);
            return (
              <div key={runId}>
                {rows.length === 0 ? (
                  <Mono faint className="block px-2.5 py-1.5 text-2xs">
                    learn ran &middot; no new or changed beliefs
                  </Mono>
                ) : (
                  rows.map((row) => (
                    <StreamRow
                      key={row.key}
                      row={row}
                      beliefs={beliefs}
                      onSelectBelief={onSelectBelief}
                    />
                  ))
                )}
              </div>
            );
          })}
        </div>
      )}

      <Footer />
    </div>
  );
}

function Header({
  live,
  scenario,
}: {
  live: boolean;
  scenario?: string | null;
}) {
  return (
    <div className="flex items-center justify-between border-b border-border px-2 pb-2">
      <Mono dim className="text-xs uppercase tracking-wide">
        Reconciliation stream
      </Mono>
      <span className="inline-flex items-center gap-2">
        {live ? (
          <span className="inline-flex items-center gap-1">
            <motion.span
              className="inline-block h-1.5 w-1.5 rounded-full"
              style={{ backgroundColor: "#4ED8C4" }}
              animate={{ opacity: [1, 0.3, 1] }}
              transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
            />
            <Mono className="text-2xs uppercase tracking-wide" style={{ color: "#4ED8C4" }}>
              &#10227; live
            </Mono>
          </span>
        ) : null}
        <Mono faint className="text-2xs">
          {scenario ?? "scratch session"}
        </Mono>
      </span>
    </div>
  );
}

function Footer() {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-2 pt-2">
      <Mono faint className="text-2xs">
        rows from POST /learn + /maintain &middot; supersede de-duped to one row
      </Mono>
      <Mono faint className="text-2xs">
        branch = contradicted&middot;kind=branch &middot; pruned = snapshot-diff tombstone
      </Mono>
    </div>
  );
}

export default ReconciliationStream;
