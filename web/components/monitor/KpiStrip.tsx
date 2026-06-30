"use client";

import * as React from "react";

import type { Belief, LearnAction, MaintainResponse, TierName } from "@/lib/api";
import { TIER_COLOR, TIER_LABEL } from "@/lib/tokens";
import { Mono } from "@/components/primitives";

/**
 * KpiStrip — the headline vitals readout at the top of the Mind Monitor (`/`).
 *
 * Mockup row:
 *   HELD 14   DORMANT 6   ARCHIVED 3   PRUNED 2↓   │  last learn +1 branched · last maintain 1 demoted 1 pruned
 *
 * It reports the four lifecycle populations + the deltas of the most recent run:
 *   - HELD / DORMANT / ARCHIVED  — counts aggregated from a GET /beliefs?all=true read
 *     (passed in as `beliefs`); "held" is the `active` tier in the engine's vocabulary.
 *   - PRUNED                     — has NO event and NO row after a maintain (the engine
 *     hard-deletes it). The only honest source is a snapshot-diff of two
 *     /beliefs?all=true reads across a maintain, which the parent owns and feeds here as
 *     `prunedCount`. The "↓" marker only shows when that diff actually found tombstones.
 *   - last learn / last maintain — the deltas the parent captured from the POST /learn and
 *     POST /maintain responses, summarized for the strip.
 *
 * Honesty constraints honored here:
 *   - Counts are derived ONLY from the props the parent read off the real API — this
 *     component never fetches, never mutates, and never invents a PRUNED row.
 *   - `branched` is a LEARN-RESULT action verb, not a belief-event type; it is summarized
 *     under "last learn" exactly as the API returns it, never promoted to a tier.
 *   - All numbers/verbs render through <Mono> (machine truth); only labels are sans.
 *
 * Presentational: every input arrives via props. The parent (Mind Monitor page) is
 * responsible for the scratch-session reads, the across-maintain snapshot-diff, and
 * stashing the last learn/maintain responses.
 */

/** The four populations shown as count cells. `pruned` is reconstructed, not a real tier. */
export type KpiTier = TierName | "pruned";

/** Summary of the last POST /learn run — counts of each action verb it returned. */
export type LearnDelta = Partial<Record<LearnAction, number>>;

/**
 * Summary of the last POST /maintain run. Either pass the raw {@link MaintainResponse}
 * (the strip will count it) or a pre-counted shape.
 */
export interface MaintainDelta {
  merged: number;
  demoted: number;
  pruned: number;
}

export interface KpiStripProps {
  /** A GET /beliefs?all=true read (full history incl. dormant/archived). */
  beliefs: Belief[];
  /**
   * PRUNED tombstone count from the across-maintain snapshot-diff (diffPruned). The
   * engine emits no event and leaves no row, so this is the only honest source — the
   * parent computes it and feeds it here. Defaults to 0 (no diff seen yet).
   */
  prunedCount?: number;
  /** Counts of each action from the last POST /learn, or null if none has run. */
  lastLearn?: LearnDelta | null;
  /**
   * The last POST /maintain result — raw response or a pre-counted {@link MaintainDelta}.
   * null when none has run.
   */
  lastMaintain?: MaintainResponse | MaintainDelta | null;
  className?: string;
}

const TIER_ORDER: KpiTier[] = ["active", "dormant", "archived", "pruned"];

/** "held" is the user-facing word for the engine's `active` tier. */
const KPI_LABEL: Record<KpiTier, string> = {
  active: "held",
  dormant: TIER_LABEL.dormant,
  archived: TIER_LABEL.archived,
  pruned: TIER_LABEL.pruned,
};

const LEARN_ORDER: LearnAction[] = [
  "formed",
  "reinforced",
  "superseded",
  "branched",
];

/** Normalize either a raw MaintainResponse or a pre-counted delta to counts. */
function maintainCounts(
  m: MaintainResponse | MaintainDelta | null | undefined,
): MaintainDelta | null {
  if (m == null) return null;
  if (Array.isArray((m as MaintainResponse).merged)) {
    const r = m as MaintainResponse;
    return {
      merged: r.merged.length,
      demoted: r.demoted.length,
      pruned: r.pruned.length,
    };
  }
  return m as MaintainDelta;
}

export function KpiStrip({
  beliefs,
  prunedCount = 0,
  lastLearn,
  lastMaintain,
  className = "",
}: KpiStripProps) {
  // Aggregate the live populations from the beliefs read.
  const tierCounts = React.useMemo(() => {
    const counts: Record<KpiTier, number> = {
      active: 0,
      dormant: 0,
      archived: 0,
      pruned: prunedCount,
    };
    for (const b of beliefs) {
      counts[b.tier] = (counts[b.tier] ?? 0) + 1;
    }
    return counts;
  }, [beliefs, prunedCount]);

  // Summarize the last learn run as e.g. "+1 branched · +2 reinforced".
  const learnSummary = React.useMemo(() => {
    if (!lastLearn) return null;
    const parts = LEARN_ORDER.flatMap((action) => {
      const n = lastLearn[action] ?? 0;
      return n > 0 ? [`+${n} ${action}`] : [];
    });
    return parts.length ? parts.join(" · ") : null;
  }, [lastLearn]);

  // Summarize the last maintain run as e.g. "1 demoted 1 pruned".
  const maintain = React.useMemo(
    () => maintainCounts(lastMaintain),
    [lastMaintain],
  );
  const maintainSummary = React.useMemo(() => {
    if (!maintain) return null;
    const parts: string[] = [];
    if (maintain.merged > 0) parts.push(`${maintain.merged} merged`);
    if (maintain.demoted > 0) parts.push(`${maintain.demoted} demoted`);
    if (maintain.pruned > 0) parts.push(`${maintain.pruned} pruned`);
    return parts.length ? parts.join(" ") : "no changes";
  }, [maintain]);

  return (
    <section
      className={`flex flex-wrap items-stretch gap-x-6 gap-y-3 rounded-md border border-border bg-surface-1 px-4 py-3 ${className}`.trim()}
      aria-label="Lifecycle vitals"
    >
      {/* tier populations */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        {TIER_ORDER.map((tier) => (
          <TierCount
            key={tier}
            tier={tier}
            count={tierCounts[tier]}
            // The "↓" tombstone marker only shows when the diff actually found prunes.
            tombstone={tier === "pruned" && tierCounts.pruned > 0}
          />
        ))}
      </div>

      {/* divider — collapses to a top rule when wrapped */}
      <div
        className="hidden w-px self-stretch bg-border sm:block"
        aria-hidden
      />

      {/* last-run deltas */}
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1">
        <Delta label="last learn">
          {learnSummary ? (
            <Mono className="text-2xs text-ink">{learnSummary}</Mono>
          ) : (
            <Mono faint className="text-2xs">
              none yet
            </Mono>
          )}
        </Delta>
        <Delta label="last maintain">
          {maintainSummary ? (
            <Mono
              className="text-2xs"
              style={{
                color: maintain && maintain.pruned > 0 ? TIER_COLOR.archived : undefined,
              }}
            >
              <span className="text-ink">{maintainSummary}</span>
            </Mono>
          ) : (
            <Mono faint className="text-2xs">
              none yet
            </Mono>
          )}
        </Delta>
      </div>
    </section>
  );
}

function TierCount({
  tier,
  count,
  tombstone,
}: {
  tier: KpiTier;
  count: number;
  tombstone: boolean;
}) {
  const color = TIER_COLOR[tier];
  const isPruned = tier === "pruned";
  return (
    <div className="flex items-center gap-1.5" title={`${KPI_LABEL[tier]} tier`}>
      {/* tier dot — filled for live tiers, outline-only for the pruned tombstone */}
      {isPruned ? (
        <span
          className="inline-block h-2 w-2 rounded-full border"
          style={{ borderColor: color }}
          aria-hidden
        />
      ) : (
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ backgroundColor: color }}
          aria-hidden
        />
      )}
      <Mono
        className="text-2xs uppercase tracking-wide"
        style={{ color }}
      >
        {KPI_LABEL[tier]}
      </Mono>
      <Mono
        className="text-sm tabular-nums"
        style={{ color, fontWeight: 500 }}
      >
        {count}
        {tombstone ? <span className="text-2xs align-top">↓</span> : null}
      </Mono>
    </div>
  );
}

function Delta({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Mono dim className="text-2xs uppercase tracking-wide">
        {label}
      </Mono>
      {children}
    </div>
  );
}
