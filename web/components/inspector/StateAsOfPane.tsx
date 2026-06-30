"use client";

import * as React from "react";
import { GitBranch, Layers } from "lucide-react";
import type { Belief, BeliefEvent, TierName } from "@/lib/api";
import { Badge, Meter, Mono } from "@/components/primitives";
import {
  RETENTION_THRESHOLDS,
  estimateRetention,
} from "@/lib/retention";
import { TIER_COLOR, fmtFloat } from "@/lib/tokens";
import { displayKind } from "@/lib/events";

/**
 * StateAsOfPane — the event-sourcing FOLD.
 *
 * Reconstructs a belief's state (tier · confidence · salience · reinforcement_count ·
 * validity · last_accessed · supersedes) AS OF a selected timeline event, by replaying the
 * raw `/beliefs/{id}/timeline` events in order up to and including the selection. This is the
 * right rail of the Belief Inspector.
 *
 * Honesty rules baked in:
 *  - Reads ONLY real events. No `branched` event type exists — a branch is a `contradicted`
 *    with detail.kind==="branch" (demotes the old belief to DORMANT, not archived); a
 *    supersede emits BOTH `contradicted` + `superseded` for one act (archives the old belief).
 *    We fold whichever rows are present without inventing transitions.
 *  - Folds only what events truthfully carry: `formed.detail.confidence`, `reinforced.detail
 *    .to_confidence`, `demoted.detail.to`, supersede/branch/merge `detail.by`/`detail.into`.
 *    `salience` is NOT carried per-event, so it is seeded from the live belief and held
 *    constant across the fold — labeled "(not event-derived)" so the panel never lies.
 *  - Live retention is an ESTIMATE (client formula); shown only for the AS-OF-now case with the
 *    governing 0.35 / 0.15 cliffs inline. For a historical fold we do not fabricate a score.
 */

interface FoldState {
  tier: TierName;
  confidence: number;
  salience: number;
  reinforcementCount: number;
  validityStart: string | null;
  validityEnd: string | null;
  lastAccessedAt: string | null;
  supersededBy: string | null;
  /** the kind of the supersede/branch/merge link, for the "supersedes" row label */
  linkKind: "branch" | "supersede" | "merge" | null;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/**
 * Fold the raw (UNcollapsed) events from oldest up to and including `throughIdx` into a single
 * reconstructed state, seeded from the live belief for fields events don't carry.
 */
function foldThrough(
  belief: Belief,
  events: BeliefEvent[],
  throughIdx: number,
): FoldState {
  // Seed: salience + type + statement come from the live belief; everything else is rebuilt
  // from events so the historical view doesn't leak the belief's final mutable state.
  const state: FoldState = {
    tier: "active",
    confidence: belief.confidence,
    salience: belief.salience,
    reinforcementCount: 0,
    validityStart: null,
    validityEnd: null,
    lastAccessedAt: null,
    supersededBy: null,
    linkKind: null,
  };

  for (let i = 0; i <= throughIdx && i < events.length; i += 1) {
    const e = events[i];
    switch (e.event_type) {
      case "formed": {
        state.tier = "active";
        state.validityStart = e.at;
        state.validityEnd = null;
        state.reinforcementCount = 0;
        const c = asNumber(e.detail?.confidence);
        if (c !== null) state.confidence = c;
        break;
      }
      case "reinforced": {
        // detail = { from_confidence, to_confidence }
        const to = asNumber(e.detail?.to_confidence);
        if (to !== null) state.confidence = to;
        state.reinforcementCount += 1;
        state.lastAccessedAt = e.at; // reinforce refreshes recency
        break;
      }
      case "contradicted": {
        // branch (detail.kind==="branch") demotes the OLD belief to dormant; a lone
        // contradicted that is the first half of a supersede pair is handled by `superseded`.
        const by = asString(e.detail?.by);
        if (by) state.supersededBy = by;
        state.validityEnd = e.at;
        if (e.detail?.kind === "branch") {
          state.tier = "dormant";
          state.linkKind = "branch";
        } else {
          // lone contradicted (supersede pair without its `superseded` row, or a raw
          // contradiction): closes validity; tier change comes from the paired `superseded`.
          state.linkKind = state.linkKind ?? "supersede";
        }
        break;
      }
      case "superseded": {
        const by = asString(e.detail?.by);
        if (by) state.supersededBy = by;
        state.tier = "archived";
        state.validityEnd = e.at;
        state.linkKind = "supersede";
        break;
      }
      case "merged": {
        const into = asString(e.detail?.into);
        if (into) state.supersededBy = into;
        state.tier = "archived";
        state.validityEnd = e.at;
        state.linkKind = "merge";
        break;
      }
      case "demoted": {
        const to = asString(e.detail?.to);
        if (to === "dormant" || to === "archived") state.tier = to;
        break;
      }
      case "promoted": {
        // touch() on a dormant belief during retrieve: back to active, recency refreshed
        state.tier = "active";
        state.lastAccessedAt = e.at;
        break;
      }
      case "pruned":
        // pruned emits no real event; defensively ignore if one ever appears.
        break;
      default:
        break;
    }
  }
  return state;
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 px-3 py-2">
      <Mono dim className="text-2xs uppercase tracking-wide pt-0.5">
        {label}
      </Mono>
      <div className="flex min-w-0 flex-1 items-center justify-end gap-2 text-right">
        {children}
      </div>
    </div>
  );
}

function fmtTs(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  );
}

export interface StateAsOfPaneProps {
  /** the live belief, used as the fold seed + the AS-OF-now retention estimate */
  belief: Belief;
  /** the RAW timeline events (oldest→newest) from GET /beliefs/{id}/timeline — pass them
   *  uncollapsed; the fold handles the supersede pair itself */
  events: BeliefEvent[];
  /** index into `events` of the selected event, or null to fold the entire history (now) */
  selectedIndex: number | null;
  /** the time cursor; drives the ESTIMATED retention shown for the AS-OF-now case */
  now?: Date;
  /** toggle the before/after diff drawer for the selected event (wired by the parent) */
  onToggleDiff?: () => void;
  className?: string;
}

/**
 * Right rail. Renders the folded state as a labeled register. When `selectedIndex` is null
 * the fold runs through every event (= "now") and the live ESTIMATED retention + distance to
 * the next demotion cliff are shown; for a historical selection retention is intentionally
 * omitted (no honest historical score without re-running the engine at that instant).
 */
export function StateAsOfPane({
  belief,
  events,
  selectedIndex,
  now = new Date(),
  onToggleDiff,
  className = "",
}: StateAsOfPaneProps) {
  const isNow = selectedIndex === null;
  const throughIdx = isNow ? events.length - 1 : selectedIndex;

  const state = React.useMemo(
    () => foldThrough(belief, events, throughIdx),
    [belief, events, throughIdx],
  );

  const selectedEvent =
    !isNow && throughIdx >= 0 && throughIdx < events.length
      ? events[throughIdx]
      : null;

  // Retention is an ESTIMATE and only honest for the live (now) fold.
  const retention = React.useMemo(
    () => (isNow ? estimateRetention(belief, now) : null),
    [isNow, belief, now],
  );

  const tierColor = TIER_COLOR[state.tier];
  const isHeld = state.tier === "active";

  const linkLabel =
    state.linkKind === "branch"
      ? "branched from"
      : state.linkKind === "merge"
        ? "merged into"
        : "supersedes";

  const heading = isNow
    ? "STATE AS OF NOW"
    : `STATE AS OF SELECTED EVENT`;

  return (
    <section
      className={`flex flex-col rounded-md border border-border bg-surface-1 ${className}`.trim()}
      aria-label="reconstructed belief state"
    >
      {/* header */}
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <Layers size={13} className="text-ink-faint" aria-hidden />
          <Mono dim className="text-2xs uppercase tracking-wide">
            {heading}
          </Mono>
        </div>
        {selectedEvent ? (
          <div className="flex items-center gap-2">
            <Badge variant="event" value={selectedEvent.event_type} />
            {onToggleDiff &&
            (displayKind(selectedEvent) === "branch" ||
              displayKind(selectedEvent) === "superseded" ||
              displayKind(selectedEvent) === "merged") ? (
              <button
                type="button"
                onClick={onToggleDiff}
                className="rounded border border-border px-2 py-0.5 text-2xs text-ink-dim transition-colors hover:border-accent/60 hover:text-accent"
              >
                <Mono className="text-2xs">◀ diff ▶</Mono>
              </button>
            ) : null}
          </div>
        ) : (
          <Mono faint className="text-2xs">
            folded · {events.length} event{events.length === 1 ? "" : "s"}
          </Mono>
        )}
      </div>

      {/* the folded register */}
      <div className="divide-y divide-border/60">
        <Row label="tier">
          <Badge variant="tier" value={state.tier} />
          {isHeld ? (
            <Mono className="text-2xs" style={{ color: tierColor }}>
              held
            </Mono>
          ) : null}
        </Row>

        <Row label="confidence">
          <Meter value={state.confidence} color={tierColor} width={96} />
        </Row>

        <Row label="salience">
          <div className="flex flex-col items-end gap-0.5">
            <Meter value={state.salience} color={tierColor} width={96} />
            <Mono faint className="text-[0.625rem]">
              not event-derived
            </Mono>
          </div>
        </Row>

        <Row label="reinf_count">
          <Mono className="text-xs">{state.reinforcementCount}</Mono>
        </Row>

        <Row label="validity">
          <Mono className="text-2xs">
            {fmtTs(state.validityStart)}{" "}
            <span className="text-ink-faint">→</span>{" "}
            {state.validityEnd ? (
              fmtTs(state.validityEnd)
            ) : (
              <span className="text-ink-dim">(open)</span>
            )}
          </Mono>
        </Row>

        <Row label="last_access">
          {state.lastAccessedAt ? (
            <Mono className="text-2xs">{fmtTs(state.lastAccessedAt)}</Mono>
          ) : (
            <Mono faint className="text-2xs">
              never
            </Mono>
          )}
        </Row>

        <Row label="supersedes">
          {state.supersededBy ? (
            <span className="inline-flex items-center gap-1.5">
              {state.linkKind === "branch" ? (
                <GitBranch size={11} className="text-event-contradicted" aria-hidden />
              ) : null}
              <Mono className="text-2xs text-ink-dim">{linkLabel}</Mono>
              <Mono className="text-2xs" style={{ color: tierColor }}>
                {state.supersededBy}
              </Mono>
            </span>
          ) : (
            <Mono faint className="text-2xs">
              —
            </Mono>
          )}
        </Row>
      </div>

      {/* estimated retention — honest, ONLY for the live (now) fold */}
      {retention ? (
        <div className="border-t border-border bg-surface-0 px-3 py-2.5">
          <div className="mb-1.5 flex items-center justify-between">
            <Mono dim className="text-2xs uppercase tracking-wide">
              retention
            </Mono>
            <Mono faint className="text-[0.625rem]">
              client est · w .5/.3/.2 · hl 14d
            </Mono>
          </div>
          <Meter
            value={retention.score}
            color={tierColor}
            width={180}
            markers={[
              {
                at: RETENTION_THRESHOLDS.archive_retention_max,
                label: "0.15 archive",
                color: TIER_COLOR.archived,
              },
              {
                at: RETENTION_THRESHOLDS.dormant_retention_max,
                label: "0.35 dormant",
                color: TIER_COLOR.dormant,
              },
            ]}
          />
          <div className="mt-1.5 flex items-center justify-between">
            <Mono faint className="text-[0.625rem]">
              cliffs {fmtFloat(RETENTION_THRESHOLDS.archive_retention_max)} /{" "}
              {fmtFloat(RETENTION_THRESHOLDS.dormant_retention_max)}
            </Mono>
            <Mono dim className="text-2xs">
              {retention.willDemote ? (
                <span className="text-event-demoted">
                  demotes → {retention.nextTier}
                </span>
              ) : retention.daysToNextDemotion !== null ? (
                <>next demote ~{Math.round(retention.daysToNextDemotion)}d</>
              ) : retention.pruneEligible ? (
                <span className="text-event-contradicted">prune eligible</span>
              ) : (
                <span className="text-ink-faint">stable on recency</span>
              )}
            </Mono>
          </div>
          {!retention.willDemote && retention.daysToNextDemotion !== null ? (
            <Mono faint className="mt-0.5 block text-[0.625rem]">
              if never accessed again
            </Mono>
          ) : null}
        </div>
      ) : (
        <div className="border-t border-border bg-surface-0 px-3 py-2">
          <Mono faint className="text-[0.625rem] leading-relaxed">
            retention is an estimate of the LIVE state only — no honest historical score
            without re-running the engine at that instant. Select “now” to see it.
          </Mono>
        </div>
      )}
    </section>
  );
}
