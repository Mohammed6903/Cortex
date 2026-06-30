"use client";

import * as React from "react";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "framer-motion";
import type { Belief, TierName } from "@/lib/api";
import { TIER_COLOR, TIER_LABEL, fmtFloat, opacityFromConfidence } from "@/lib/tokens";
import { estimateRetention } from "@/lib/retention";
import type { RetentionThresholds, RetentionWeights } from "@/lib/retention";
import { Mono } from "@/components/primitives";

/**
 * TierLadder — the "BELIEFS BY TIER" panel of the Mind Monitor.
 *
 * Three stacked lanes (active=cyan / dormant=amber / archived=slate). Every belief is one
 * row whose OPACITY encodes confidence (a 0.28 belief literally fades). Rows are keyed by
 * belief id inside a shared LayoutGroup, so when a maintain demotes/promotes a belief the
 * row physically slides between lanes (framer-motion layout animation) rather than blinking.
 *
 * Presentational: data arrives via `beliefs`; selection is LIFTED — clicking a row calls
 * `onSelect(id)` so the parent can highlight the same belief in the RetentionHistogram.
 *
 * Honesty: retention here is the CLIENT estimate (estimateRetention) and is labeled `e`;
 * the `now` used for the estimate is passed in so it stays in lockstep with the scrubber.
 * Archived beliefs that are prune-eligible get a quiet `prune?` flag — there is no pruned
 * lane here (prune emits no event; tombstones are reconstructed elsewhere via snapshot-diff).
 */

const LANES: TierName[] = ["active", "dormant", "archived"];

type RetentionFlag = "warm" | "cliff" | null;

function laneDot(tier: TierName, retention: number, thresholds: RetentionThresholds): string {
  // active lane: ● held / ○ used (cooling). dormant: ◐ partial. archived: ⊗ closed.
  if (tier === "active") return retention >= thresholds.dormant_retention_max ? "●" : "○";
  if (tier === "dormant") return "◐";
  return "⊗";
}

export interface TierLadderProps {
  beliefs: Belief[];
  /** Lifted selection — the belief highlighted across the monitor (histogram etc.). */
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** `now` for the client retention estimate — keep in lockstep with the time scrubber. */
  now?: Date | number;
  /** Optional config-sourced overrides so thresholds aren't hardcoded twice. */
  weights?: RetentionWeights;
  thresholds?: RetentionThresholds;
  /** Optional: a belief id to pulse (e.g. just-retrieved → warm-up). */
  pulseId?: string | null;
  /**
   * Optional: belief ids that just DEMOTED on the last maintain. Their rows flash amber as
   * they slide down a lane (the LayoutGroup handles the slide; this adds the diegetic flash).
   * Reduced-motion swaps the flash for a persistent amber `▽demoted` tag (labeled, no motion).
   */
  flashDemotedIds?: ReadonlySet<string> | null;
  /**
   * Optional: the signature warm-up affordance. When provided, cooling beliefs (dormant, or
   * active-below-the-cliff) get a quiet `↑retrieve` button that calls back with the belief so
   * the page can POST /retrieve at the current `now` and watch the row promote dormant → active.
   */
  onRetrieve?: (belief: Belief) => void;
  className?: string;
}

interface LaneRow {
  belief: Belief;
  score: number;
  willDemote: boolean;
  pruneEligible: boolean;
  flag: RetentionFlag;
}

function buildLane(
  beliefs: Belief[],
  tier: TierName,
  now: Date | number,
  weights?: RetentionWeights,
  thresholds?: RetentionThresholds,
): LaneRow[] {
  return beliefs
    .filter((b) => b.tier === tier)
    .map<LaneRow>((belief) => {
      const est = estimateRetention(belief, now, weights, thresholds);
      let flag: RetentionFlag = null;
      if (tier === "active" && est.score < (thresholds?.dormant_retention_max ?? 0.35)) {
        flag = "cliff";
      } else if (tier !== "active" && belief.last_accessed_at) {
        flag = "warm";
      }
      return {
        belief,
        score: est.score,
        willDemote: est.willDemote,
        pruneEligible: est.pruneEligible,
        flag,
      };
    })
    .sort((a, b) => b.score - a.score);
}

export function TierLadder({
  beliefs,
  selectedId,
  onSelect,
  now = Date.now(),
  weights,
  thresholds,
  pulseId = null,
  flashDemotedIds = null,
  onRetrieve,
  className = "",
}: TierLadderProps) {
  const reduce = useReducedMotion();

  const lanes = React.useMemo(
    () =>
      LANES.map((tier) => ({
        tier,
        rows: buildLane(beliefs, tier, now, weights, thresholds),
      })),
    [beliefs, now, weights, thresholds],
  );

  return (
    <section
      className={`flex min-h-0 flex-col gap-3 ${className}`.trim()}
      aria-label="Beliefs by tier"
    >
      <header className="flex items-center justify-between">
        <Mono className="text-2xs uppercase tracking-widest text-ink">Beliefs by Tier</Mono>
        <Mono faint className="text-2xs">
          opacity = confidence · score est
        </Mono>
      </header>

      <LayoutGroup>
        <div className="flex min-h-0 flex-col gap-3 overflow-auto pr-1">
          {lanes.map(({ tier, rows }) => (
            <Lane
              key={tier}
              tier={tier}
              rows={rows}
              selectedId={selectedId}
              onSelect={onSelect}
              onRetrieve={onRetrieve}
              pulseId={pulseId}
              flashDemotedIds={flashDemotedIds}
              reduce={!!reduce}
              thresholds={thresholds}
            />
          ))}
        </div>
      </LayoutGroup>
    </section>
  );
}

function Lane({
  tier,
  rows,
  selectedId,
  onSelect,
  onRetrieve,
  pulseId,
  flashDemotedIds,
  reduce,
  thresholds,
}: {
  tier: TierName;
  rows: LaneRow[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onRetrieve?: (belief: Belief) => void;
  pulseId: string | null;
  flashDemotedIds?: ReadonlySet<string> | null;
  reduce: boolean;
  thresholds?: RetentionThresholds;
}) {
  const color = TIER_COLOR[tier];
  const th = {
    dormant_retention_max: thresholds?.dormant_retention_max ?? 0.35,
    archive_retention_max: thresholds?.archive_retention_max ?? 0.15,
    prune_salience_max: thresholds?.prune_salience_max ?? 0.2,
  };
  return (
    <div className="flex flex-col gap-1">
      {/* lane header — colored rule + count */}
      <div className="flex items-center gap-2">
        <Mono className="text-2xs uppercase tracking-wide" style={{ color }}>
          {TIER_LABEL[tier]}
        </Mono>
        <span
          className="inline-block h-px flex-1"
          style={{ backgroundColor: `${color}40` }}
        />
        <Mono className="text-2xs" style={{ color }}>
          {rows.length}
        </Mono>
      </div>

      {rows.length === 0 ? (
        <Mono faint className="px-2 py-1 text-2xs italic">
          — empty
        </Mono>
      ) : (
        <div className="flex flex-col">
          <AnimatePresence initial={false}>
            {rows.map((row) => (
              <Row
                key={row.belief.id}
                row={row}
                tier={tier}
                color={color}
                selected={row.belief.id === selectedId}
                onSelect={onSelect}
                onRetrieve={onRetrieve}
                pulse={row.belief.id === pulseId}
                flashDemote={!!flashDemotedIds?.has(row.belief.id)}
                reduce={reduce}
                thresholds={th}
              />
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

function Row({
  row,
  tier,
  color,
  selected,
  onSelect,
  onRetrieve,
  pulse,
  flashDemote,
  reduce,
  thresholds,
}: {
  row: LaneRow;
  tier: TierName;
  color: string;
  selected: boolean;
  onSelect: (id: string | null) => void;
  onRetrieve?: (belief: Belief) => void;
  pulse: boolean;
  flashDemote: boolean;
  reduce: boolean;
  thresholds: RetentionThresholds;
}) {
  const { belief, score, pruneEligible, flag } = row;
  const opacity = opacityFromConfidence(belief.confidence);
  const dot = laneDot(tier, score, thresholds);

  // Reinforcement annotation: ↑N when reinforced; · when never. used = touched.
  const reinfTag =
    belief.reinforcement_count > 0 ? `↑${belief.reinforcement_count}` : "·";

  // The warm-up affordance shows on COOLING beliefs: dormant (any), or active below the
  // dormant cliff. Retrieving them resets last_accessed_at + promotes dormant → active.
  const cooling = tier === "dormant" || (tier === "active" && flag === "cliff");
  const showRetrieve = !!onRetrieve && cooling;

  return (
    <motion.button
      type="button"
      layout={reduce ? false : "position"}
      initial={reduce ? false : { opacity: 0, y: -4 }}
      animate={
        reduce
          ? { opacity: 1 }
          : {
              opacity: 1,
              y: 0,
              // pulse = cyan warm-up ring; flashDemote = amber flash as the row slides a lane.
              boxShadow: pulse
                ? `0 0 0 1px ${color}, 0 0 12px ${color}66`
                : flashDemote
                  ? [
                      `0 0 0 0px rgba(0,0,0,0)`,
                      `0 0 0 1px ${TIER_COLOR.dormant}, 0 0 14px ${TIER_COLOR.dormant}88`,
                      `0 0 0 0px rgba(0,0,0,0)`,
                    ]
                  : "0 0 0 0px rgba(0,0,0,0)",
            }
      }
      exit={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
      transition={
        reduce
          ? { duration: 0 }
          : {
              type: "spring",
              stiffness: 420,
              damping: 34,
              opacity: { duration: 0.15 },
              boxShadow: flashDemote
                ? { duration: 1.1, times: [0, 0.25, 1] }
                : { duration: 0.2 },
            }
      }
      onClick={() => onSelect(selected ? null : belief.id)}
      aria-pressed={selected}
      className="group grid w-full grid-cols-[14px_1fr_auto] items-center gap-2 rounded-sm px-2 py-1 text-left transition-colors"
      style={{
        backgroundColor: selected ? `${color}1A` : "transparent",
        outline: selected ? `1px solid ${color}80` : "1px solid transparent",
      }}
    >
      {/* tier dot — full strength so the lane stays legible even for faint beliefs */}
      <Mono
        className="text-2xs leading-none"
        style={{ color, opacity: Math.max(opacity, 0.55) }}
      >
        {dot}
      </Mono>

      {/* statement — Inter prose, opacity = confidence */}
      <span
        className="truncate font-sans text-xs text-ink group-hover:text-ink"
        style={{ opacity }}
        title={belief.statement}
      >
        {belief.statement}
      </span>

      {/* machine truth — confidence / salience / annotation */}
      <span className="flex items-center gap-2 whitespace-nowrap">
        {/* reduced-motion fallback for the amber demotion flash — a labeled (no-motion) tag */}
        {flashDemote && reduce ? (
          <Mono
            className="text-2xs"
            style={{ color: TIER_COLOR.dormant }}
            title="just demoted (motion suppressed)"
          >
            ▽demoted
          </Mono>
        ) : null}
        {/* signature warm-up affordance — appears on cooling rows; retrieving promotes it.
            role=button (not a nested <button>, which is invalid inside the row button). */}
        {showRetrieve ? (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onRetrieve?.(belief);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                onRetrieve?.(belief);
              }
            }}
            className="mono rounded-sm border px-1 py-0.5 text-2xs opacity-0 transition-opacity hover:bg-accent/10 group-hover:opacity-100 focus:opacity-100"
            style={{ borderColor: `${TIER_COLOR.active}66`, color: TIER_COLOR.active }}
            title="retrieve — warms this belief (dormant → active)"
          >
            ↑retrieve
          </span>
        ) : null}
        <Mono dim className="text-2xs" title="confidence">
          c{fmtFloat(belief.confidence)}
        </Mono>
        <Mono dim className="text-2xs" title="salience">
          s{fmtFloat(belief.salience)}
        </Mono>
        {tier === "active" ? (
          <Mono
            className="w-9 text-right text-2xs"
            style={{ color: flag === "cliff" ? TIER_COLOR.dormant : "#9AA3AF" }}
            title="reinforcement count"
          >
            {flag === "cliff" ? "cliff" : reinfTag}
          </Mono>
        ) : pruneEligible ? (
          <Mono className="w-9 text-right text-2xs" style={{ color: TIER_COLOR.archived }}>
            prune?
          </Mono>
        ) : (
          <Mono dim className="w-9 text-right text-2xs" title="estimated retention score">
            ~{fmtFloat(score)}e
          </Mono>
        )}
      </span>
    </motion.button>
  );
}
