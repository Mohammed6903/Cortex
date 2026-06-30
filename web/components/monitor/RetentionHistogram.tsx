"use client";

import * as React from "react";
import { motion, useReducedMotion } from "framer-motion";

import type { Belief } from "@/lib/api";
import {
  estimateRetention,
  RETENTION_THRESHOLDS,
  type RetentionThresholds,
  type RetentionWeights,
} from "@/lib/retention";
import { fmtFloat, tierColor } from "@/lib/tokens";
import { Mono } from "@/components/primitives";

/**
 * RetentionHistogram — the "RETENTION SCORE DISTRIBUTION (est·client)" panel of the
 * Mind Monitor hero (`/`).
 *
 * It bins every belief by its ESTIMATED retention score (client port of the engine
 * formula via lib/retention) into score buckets and draws styled-div bars, with the two
 * governing cliffs drawn as VISIBLE vertical markers:
 *   - 0.15 (archive_retention_max) — dormant → archived
 *   - 0.35 (dormant_retention_max) — active → dormant
 * The selected belief gets a live signal-cyan dot floated at its exact score so you can
 * watch it snap right of the 0.35 cliff on a `retrieve` warm-up, or drift left across the
 * cliffs as `now` advances.
 *
 * Honesty constraints honored here (design constraint #4):
 *   - Every score is recomputed by `estimateRetention`, never a server field, so the panel
 *     is explicitly labeled "est · client" and the governing thresholds are shown inline.
 *   - The cliff markers carry their numeric thresholds; the legend names what each cliff
 *     demotes between, so the distribution never silently implies these are exact.
 *
 * Presentational: all data arrives via props. The only computation is bucketing + the
 * client retention estimate (which is itself a labeled estimate).
 */

/** Bucket upper-edges over [0,1]. A score falls in the first bucket whose edge it is < of. */
const BUCKET_EDGES = [
  0.1, 0.15, 0.25, 0.35, 0.45, 0.55, 0.7, 0.85, 1.0,
] as const;

function bucketIndex(score: number): number {
  for (let i = 0; i < BUCKET_EDGES.length; i++) {
    if (score < BUCKET_EDGES[i]) return i;
  }
  return BUCKET_EDGES.length - 1;
}

export interface RetentionHistogramProps {
  /** All beliefs to distribute (typically GET /beliefs?all=true). */
  beliefs: Belief[];
  /** The currently-selected belief id — gets the live cyan dot at its exact score. */
  selectedId?: string | null;
  /** Reference `now` for the retention estimate. Defaults to Date.now(). */
  now?: Date | number;
  /** Engine weights from GET /config; falls back to documented defaults inside lib/retention. */
  weights?: RetentionWeights;
  /** Engine thresholds from GET /config; falls back to documented defaults. */
  thresholds?: RetentionThresholds;
  /** Total drawn height of the bar field, px. */
  height?: number;
  className?: string;
}

export function RetentionHistogram({
  beliefs,
  selectedId,
  now = Date.now(),
  weights,
  thresholds = RETENTION_THRESHOLDS,
  height = 132,
  className = "",
}: RetentionHistogramProps) {
  const reduce = useReducedMotion();
  const archiveCliff = thresholds.archive_retention_max; // 0.15
  const dormantCliff = thresholds.dormant_retention_max; // 0.35

  // Track the previous selected score so a `retrieve` warm-up can show a labeled
  // before → after when motion is suppressed (reduced-motion swaps the slide for text).
  const prevScoreRef = React.useRef<number | null>(null);

  const { counts, maxCount, selected } = React.useMemo(() => {
    const counts = new Array<number>(BUCKET_EDGES.length).fill(0);
    let selected: { score: number; belief: Belief } | null = null;
    for (const b of beliefs) {
      const est = estimateRetention(b, now, weights, thresholds);
      counts[bucketIndex(est.score)] += 1;
      if (selectedId && b.id === selectedId) {
        selected = { score: est.score, belief: b };
      }
    }
    const maxCount = counts.reduce((m, c) => Math.max(m, c), 0);
    return { counts, maxCount, selected };
  }, [beliefs, selectedId, now, weights, thresholds]);

  // The score the selected dot held on the previous render (for the reduced-motion label),
  // captured BEFORE we commit the new one in the effect below.
  const prevScore =
    selected && prevScoreRef.current !== selected.score
      ? prevScoreRef.current
      : null;
  React.useEffect(() => {
    prevScoreRef.current = selected ? selected.score : null;
  }, [selected]);

  // Y-axis ticks: 0, midway, top — rounded to the max count (min 1 so we never divide by 0).
  const yTop = Math.max(1, maxCount);
  const yTicks = [yTop, Math.round(yTop / 2), 0];

  /** A cliff's horizontal position as a 0..1 fraction across the [0,1] score axis. */
  const cliffLeft = (score: number) => `${Math.min(1, Math.max(0, score)) * 100}%`;

  return (
    <div className={`flex flex-col gap-2 ${className}`.trim()}>
      {/* header */}
      <div className="flex items-baseline justify-between">
        <Mono dim className="text-2xs uppercase tracking-wide">
          retention score distribution
        </Mono>
        <Mono faint className="text-2xs">
          est · client · w sal {fmtFloat(weights?.w_salience ?? 0.5, 1)} reinf{" "}
          {fmtFloat(weights?.w_reinforcement ?? 0.3, 1)} rec{" "}
          {fmtFloat(weights?.w_recency ?? 0.2, 1)} · hl14d
        </Mono>
      </div>

      {/* plot: y-axis ticks + bar field (with cliffs + selected dot overlaid) */}
      <div className="flex gap-2">
        {/* y-axis */}
        <div
          className="flex flex-col justify-between"
          style={{ height }}
          aria-hidden
        >
          {yTicks.map((t, i) => (
            <Mono key={i} faint className="text-2xs leading-none">
              {t}
            </Mono>
          ))}
        </div>

        {/* bar field */}
        <div className="relative flex-1">
          <div
            className="flex items-end gap-1 border-b border-border"
            style={{ height }}
            role="img"
            aria-label={`Retention score distribution over ${beliefs.length} beliefs (estimated)`}
          >
            {counts.map((c, i) => {
              const frac = c / yTop;
              const barColor = colorForBucket(i, archiveCliff, dormantCliff);
              return (
                <div
                  key={i}
                  className="group relative flex flex-1 items-end justify-center"
                  style={{ height: "100%" }}
                  title={`${c} belief${c === 1 ? "" : "s"} · score < ${fmtFloat(
                    BUCKET_EDGES[i],
                  )}`}
                >
                  <div
                    className="w-full rounded-t-[2px]"
                    style={{
                      height: c === 0 ? 2 : `${Math.max(4, frac * 100)}%`,
                      backgroundColor: barColor,
                      opacity: c === 0 ? 0.18 : 0.85,
                    }}
                  />
                  {c > 0 ? (
                    <Mono
                      faint
                      className="pointer-events-none absolute -top-[14px] text-2xs leading-none"
                    >
                      {c}
                    </Mono>
                  ) : null}
                </div>
              );
            })}

            {/* --- cliff markers (overlaid across the whole field) --- */}
            <CliffMarker
              left={cliffLeft(archiveCliff)}
              color={tierColor("archived")}
              value={archiveCliff}
              label="archive"
            />
            <CliffMarker
              left={cliffLeft(dormantCliff)}
              color={tierColor("dormant")}
              value={dormantCliff}
              label="dormant"
            />

            {/* --- live selected dot at its exact score (animates right on warm-up) --- */}
            {selected ? (
              <motion.div
                className="pointer-events-none absolute bottom-0 z-10 -translate-x-1/2"
                // when motion is allowed the dot SLIDES to its new score (snaps right on a
                // retrieve warm-up); reduced-motion jumps instantly and we label the change.
                initial={false}
                animate={{ left: cliffLeft(selected.score) }}
                transition={
                  reduce
                    ? { duration: 0 }
                    : { type: "spring", stiffness: 380, damping: 30 }
                }
                title={`${selected.belief.statement} · est score ${fmtFloat(
                  selected.score,
                )}`}
              >
                <span
                  className="block h-2.5 w-2.5 rounded-full ring-2 ring-canvas"
                  style={{ backgroundColor: tierColor("active") }}
                  aria-label={`selected belief estimated score ${fmtFloat(
                    selected.score,
                  )}`}
                />
              </motion.div>
            ) : null}
          </div>

          {/* x-axis bucket edge labels */}
          <div className="mt-1 flex">
            {BUCKET_EDGES.map((e, i) => (
              <Mono key={i} faint className="flex-1 text-center text-2xs leading-none">
                {fmtFloat(e).replace(/^0/, "")}
              </Mono>
            ))}
          </div>
        </div>
      </div>

      {/* legend: name the cliffs + the selected dot */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pl-6">
        <LegendCliff color={tierColor("archived")} value={archiveCliff} text="archive cliff" />
        <LegendCliff color={tierColor("dormant")} value={dormantCliff} text="dormant cliff" />
        <span className="inline-flex items-center gap-1.5">
          <span
            className="block h-2 w-2 rounded-full"
            style={{ backgroundColor: tierColor("active") }}
            aria-hidden
          />
          <Mono faint className="text-2xs">
            ● = selected belief (est)
          </Mono>
        </span>
        {selected ? (
          <Mono faint className="text-2xs">
            {/* reduced-motion swaps the slide for a labeled before → after; otherwise just
                the current score (the dot itself carries the snap-right motion). */}
            {reduce && prevScore != null && Math.abs(prevScore - selected.score) > 0.005 ? (
              <>
                selected ~{fmtFloat(prevScore)}e &rarr; ~{fmtFloat(selected.score)}e{" "}
                <span style={{ color: tierColor("active") }}>(no motion)</span>
              </>
            ) : (
              <>selected ~{fmtFloat(selected.score)}e</>
            )}
          </Mono>
        ) : null}
      </div>
    </div>
  );
}

/** A bucket's bar color: left of archive = archived slate, between cliffs = dormant amber,
 *  right of dormant = active cyan — so the distribution itself reads the tier ramp. */
function colorForBucket(
  index: number,
  archiveCliff: number,
  dormantCliff: number,
): string {
  // Use the bucket's upper edge as its representative score for coloring.
  const edge = BUCKET_EDGES[index];
  if (edge <= archiveCliff) return tierColor("archived");
  if (edge <= dormantCliff) return tierColor("dormant");
  return tierColor("active");
}

function CliffMarker({
  left,
  color,
  value,
  label,
}: {
  left: string;
  color: string;
  value: number;
  label: string;
}) {
  return (
    <div
      className="pointer-events-none absolute bottom-0 top-0 z-[5] flex flex-col items-center"
      style={{ left }}
      aria-hidden
    >
      <div
        className="w-px flex-1"
        style={{ backgroundColor: color, opacity: 0.7 }}
      />
      <Mono
        className="absolute -top-[2px] -translate-x-1/2 whitespace-nowrap text-2xs leading-none"
        style={{ color, left: "0px" }}
      >
        ↑{label} {fmtFloat(value)}
      </Mono>
    </div>
  );
}

function LegendCliff({
  color,
  value,
  text,
}: {
  color: string;
  value: number;
  text: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="block h-3 w-px" style={{ backgroundColor: color }} aria-hidden />
      <Mono faint className="text-2xs">
        {text} {fmtFloat(value)}
      </Mono>
    </span>
  );
}
