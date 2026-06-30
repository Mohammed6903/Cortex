"use client";

import * as React from "react";
import { FileText } from "lucide-react";

import type { Belief } from "@/lib/api";
import {
  estimateRetention,
  RETENTION_THRESHOLDS,
  RETENTION_WEIGHTS,
  RECENCY_HALFLIFE_DAYS,
  type RetentionThresholds,
  type RetentionWeights,
} from "@/lib/retention";
import {
  TIER_COLOR,
  TIER_LABEL,
  fmtFloat,
  opacityFromConfidence,
  weightFromConfidence,
} from "@/lib/tokens";
import { Badge, Meter, Mono } from "@/components/primitives";

/**
 * BeliefHeaderCard — the KPI header of the Belief Inspector (`/belief/[id]`).
 *
 * It is the headline vitals readout for ONE belief:
 *   - the `statement` in Inter prose (weight + opacity encode confidence),
 *   - type + tier badges (the fixed tier ramp),
 *   - confidence / salience Meters (BOTH a number AND opacity/weight),
 *   - LIVE *estimated* retention recomputed client-side from lib/retention with the
 *     governing thresholds shown inline + a "next demote ~Nd" distance, and
 *   - a provenance affordance into the source episodes.
 *
 * Honesty constraints honored here:
 *   - Retention is computed by `estimateRetention` (client port of the engine formula)
 *     and is ALWAYS labeled "est" with the weights + cliffs surfaced, so the headline
 *     metric never silently lies (design constraint #4).
 *   - A *formed-only* belief (never accessed, reinforcement_count 0) gets honest copy:
 *     retention reads against `created_at`, last-access shows "never", and the demote
 *     distance is stated as "if never accessed".
 *   - This component never mutates anything — it is a pure read of a Belief plus the
 *     client estimate. All lifecycle mutation happens via the scratch session elsewhere.
 */

export interface BeliefHeaderCardProps {
  belief: Belief;
  /** The time cursor (scratch `now`). Drives the live retention estimate. */
  now?: Date | number;
  /** Optional override of the retention weights (e.g. fed from GET /config). */
  weights?: RetentionWeights;
  /** Optional override of the retention thresholds (e.g. fed from GET /config). */
  thresholds?: RetentionThresholds;
  /**
   * Provenance affordance. When provided, renders a "provenance ▸" trigger that opens
   * the source episodes (the parent owns the drawer/pane). Omit to hide the affordance.
   */
  onOpenProvenance?: (beliefId: string) => void;
  /** Optional count of known source episodes, surfaced next to the affordance. */
  provenanceCount?: number | null;
  className?: string;
}

const DEFAULT_WEIGHTS: RetentionWeights = {
  ...RETENTION_WEIGHTS,
  recency_halflife_days: RECENCY_HALFLIFE_DAYS,
};

/** Human "~Nd" / "~N.Nmo" / "~N.Ny" for a day count. */
function fmtHorizon(days: number): string {
  if (days < 1) return "<1d";
  if (days < 60) return `${Math.round(days)}d`;
  if (days < 730) return `${(days / 30).toFixed(1)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}

export function BeliefHeaderCard({
  belief,
  now = Date.now(),
  weights = DEFAULT_WEIGHTS,
  thresholds = RETENTION_THRESHOLDS,
  onOpenProvenance,
  provenanceCount,
  className = "",
}: BeliefHeaderCardProps) {
  const est = React.useMemo(
    () => estimateRetention(belief, now, weights, thresholds),
    [belief, now, weights, thresholds],
  );

  const tierColor = TIER_COLOR[belief.tier];
  const isActive = belief.tier === "active";
  const neverAccessed = belief.last_accessed_at == null;
  const formedOnly =
    belief.reinforcement_count === 0 &&
    neverAccessed &&
    belief.superseded_by == null;

  const statementOpacity = opacityFromConfidence(belief.confidence);
  const statementWeight = weightFromConfidence(belief.confidence);

  // Retention bar hue tracks how close we are to the next cliff.
  const retentionColor = est.willDemote
    ? "#D86A6A"
    : isActive
      ? "#4ED8C4"
      : tierColor;

  // The cliff that THIS tier faces next (for the inline marker on the retention meter).
  const nextCliff =
    belief.tier === "active"
      ? thresholds.dormant_retention_max
      : belief.tier === "dormant"
        ? thresholds.archive_retention_max
        : null;

  return (
    <section
      className={`rounded-md border border-border bg-surface-1 p-4 ${className}`.trim()}
      aria-label="Belief header"
    >
      {/* statement — Inter prose, weight + opacity encode confidence */}
      <h1
        className="font-sans text-lg leading-snug text-ink"
        style={{ fontWeight: statementWeight, opacity: statementOpacity }}
      >
        {belief.statement}
      </h1>

      {/* id · type · tier */}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Mono dim className="text-2xs" title="belief id">
          {belief.id}
        </Mono>
        <Badge variant="type" value={belief.type} />
        <Badge variant="tier" value={belief.tier} />
        <Mono className="text-2xs" style={{ color: tierColor }}>
          {isActive
            ? "currently held"
            : `${TIER_LABEL[belief.tier]} · not active`}
        </Mono>
      </div>

      <div className="mt-3 h-px bg-border" />

      {/* confidence + salience meters — number AND opacity/weight */}
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex items-center justify-between gap-3">
          <Mono dim className="text-2xs uppercase tracking-wide">
            confidence
          </Mono>
          <Meter
            value={belief.confidence}
            color="#4ED8C4"
            width={120}
            digits={2}
          />
        </div>
        <div className="flex items-center justify-between gap-3">
          <Mono dim className="text-2xs uppercase tracking-wide">
            salience
          </Mono>
          <Meter
            value={belief.salience}
            color="#9AA3AF"
            width={120}
            digits={2}
          />
        </div>
      </div>

      {/* live ESTIMATED retention — always labeled, thresholds inline */}
      <div className="mt-3 rounded border border-border bg-surface-0 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Mono dim className="text-2xs uppercase tracking-wide">
              retention
            </Mono>
            <Mono
              className="text-2xs"
              style={{ color: "#E0A458" }}
              title="client-side estimate — server is source of truth"
            >
              est
            </Mono>
          </div>
          <Meter
            value={est.score}
            color={retentionColor}
            width={140}
            digits={2}
            markers={
              nextCliff != null
                ? [
                    {
                      at: thresholds.archive_retention_max,
                      label: `archive cliff ${fmtFloat(
                        thresholds.archive_retention_max,
                      )}`,
                      color: "#5B6470",
                    },
                    {
                      at: thresholds.dormant_retention_max,
                      label: `dormant cliff ${fmtFloat(
                        thresholds.dormant_retention_max,
                      )}`,
                      color: "#E0A458",
                    },
                  ]
                : undefined
            }
          />
        </div>

        {/* distance to next demotion — the headline vitals line */}
        <div className="mt-2">
          {belief.tier === "archived" ? (
            <Mono dim className="text-2xs">
              {est.pruneEligible
                ? "archived · prune-eligible (salience ≤ "
                : "archived · terminal tier · "}
              {est.pruneEligible
                ? `${fmtFloat(thresholds.prune_salience_max)}, never accessed)`
                : "no further demotion"}
            </Mono>
          ) : est.willDemote ? (
            <Mono className="text-2xs" style={{ color: "#D86A6A" }}>
              ↓ below {fmtFloat(nextCliff ?? 0)} cliff — would demote{" "}
              {belief.tier}→{est.nextTier} on next maintain
            </Mono>
          ) : est.daysToNextDemotion != null ? (
            <Mono dim className="text-2xs">
              next demote{" "}
              <span style={{ color: "#E0A458" }}>
                ~{fmtHorizon(est.daysToNextDemotion)}
              </span>{" "}
              ({belief.tier}→{est.nextTier} at {fmtFloat(nextCliff ?? 0)})
              {neverAccessed ? " · if never accessed" : ""}
            </Mono>
          ) : (
            <Mono dim className="text-2xs">
              stable — salience + reinforcement hold it above the{" "}
              {fmtFloat(nextCliff ?? 0)} cliff on recency alone
            </Mono>
          )}
        </div>

        {/* governing formula + cliffs, so the estimate never silently lies */}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <Mono faint className="text-2xs">
            w sal {fmtFloat(weights.w_salience, 1)} · reinf{" "}
            {fmtFloat(weights.w_reinforcement, 1)} · rec{" "}
            {fmtFloat(weights.w_recency, 1)} · hl{" "}
            {weights.recency_halflife_days}d
          </Mono>
          <Mono faint className="text-2xs">
            score {fmtFloat(est.score, 4)} = .5·sal + .3·reinf + .2·rec
          </Mono>
        </div>
      </div>

      {/* raw state line — machine truth */}
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3">
        <StateField
          label="reinf_count"
          value={<Mono className="text-2xs">{belief.reinforcement_count}</Mono>}
        />
        <StateField
          label="last_access"
          value={
            neverAccessed ? (
              <Mono faint className="text-2xs">
                never
              </Mono>
            ) : (
              <Mono className="text-2xs">{belief.last_accessed_at}</Mono>
            )
          }
        />
        <StateField
          label="validity"
          value={
            <Mono className="text-2xs">
              {belief.validity_start}
              {" → "}
              {belief.validity_end ?? "(open)"}
            </Mono>
          }
        />
        {belief.superseded_by ? (
          <StateField
            label="superseded_by"
            value={
              <Mono className="text-2xs" style={{ color: "#D86A6A" }}>
                {belief.superseded_by}
              </Mono>
            }
          />
        ) : null}
        <StateField
          label="created_at"
          value={
            belief.created_at ? (
              <Mono className="text-2xs">{belief.created_at}</Mono>
            ) : (
              <Mono faint className="text-2xs">
                —
              </Mono>
            )
          }
        />
      </div>

      {/* honest formed-only note */}
      {formedOnly ? (
        <div className="mt-3 rounded border border-dashed border-border bg-surface-0 px-3 py-2">
          <Mono faint className="text-2xs">
            formed-only · never reinforced or accessed — retention is measured from
            created_at and decays on recency alone
          </Mono>
        </div>
      ) : null}

      {/* provenance affordance */}
      {onOpenProvenance ? (
        <button
          type="button"
          onClick={() => onOpenProvenance(belief.id)}
          className="mt-3 inline-flex items-center gap-1.5 rounded border border-border bg-surface-2 px-2 py-1 text-ink-dim transition-colors hover:border-accent/60 hover:text-ink"
        >
          <FileText size={13} aria-hidden />
          <Mono className="text-2xs lowercase">provenance ▸</Mono>
          {provenanceCount != null ? (
            <Mono dim className="text-2xs">
              {provenanceCount} episode{provenanceCount === 1 ? "" : "s"}
            </Mono>
          ) : null}
        </button>
      ) : null}
    </section>
  );
}

function StateField({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <Mono dim className="text-2xs uppercase tracking-wide">
        {label}
      </Mono>
      {value}
    </div>
  );
}
