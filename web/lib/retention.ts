/**
 * Client-side port of cortex/lifecycle/retention.py.
 *
 * This is an ESTIMATE — the server is the source of truth. Anything rendered from
 * this module MUST be labeled "estimated" / "est" with the governing thresholds shown
 * inline, so the headline metric never silently lies (design honesty constraint #4).
 *
 * Port fidelity:
 *   reference     = last_accessed_at ?? created_at ?? now
 *   days          = max(0, (now - reference) / 86400000)
 *   recency       = 0.5 ** (days / halflife)            // halflife 14d
 *   reinforcement = 1 - 1 / (1 + reinforcement_count)   // diminishing returns
 *   raw           = w_sal*salience + w_reinf*reinforcement + w_rec*recency
 *   score         = raw / (w_sal + w_reinf + w_rec)     // normalize (weights -> 1.0 by default)
 *
 *   demote active  -> dormant  when score < 0.35  (dormant_retention_max)
 *   demote dormant -> archived when score < 0.15  (archive_retention_max)
 */

import type { Belief, ConfigResponse, TierName } from "./api";

export const RETENTION_WEIGHTS = {
  w_salience: 0.5,
  w_reinforcement: 0.3,
  w_recency: 0.2,
} as const;

export const RETENTION_THRESHOLDS = {
  /** active -> dormant cliff */
  dormant_retention_max: 0.35,
  /** dormant -> archived cliff */
  archive_retention_max: 0.15,
  /** prune eligibility salience ceiling */
  prune_salience_max: 0.2,
} as const;

export const RECENCY_HALFLIFE_DAYS = 14;

const MS_PER_DAY = 86_400_000;

export interface RetentionWeights {
  w_salience: number;
  w_reinforcement: number;
  w_recency: number;
  recency_halflife_days: number;
}

export interface RetentionThresholds {
  dormant_retention_max: number;
  archive_retention_max: number;
  prune_salience_max: number;
}

export interface RetentionEstimate {
  /** retention score in [0,1] */
  score: number;
  /** recency component 0.5 ** (days/halflife) */
  recency: number;
  /** reinforcement component 1 - 1/(1+count) */
  reinforcement: number;
  /** salience component (raw, pre-weight) */
  salience: number;
  /** days since reference (last_access ?? created) */
  daysSinceReference: number;
  /** the tier this belief would land in at `now` if a maintain ran (one step) */
  nextTier: TierName;
  /** true if the current tier would change on the next maintain */
  willDemote: boolean;
  /**
   * Estimated days from `now` until this belief crosses its next demotion cliff,
   * assuming it is NEVER accessed again (so recency keeps decaying). null when the
   * belief is already archived or salience/reinforcement alone keep it above the cliff
   * forever (it will never demote on recency).
   */
  daysToNextDemotion: number | null;
  /** prune eligibility per cortex prune(): archived && salience<=0.2 && never accessed */
  pruneEligible: boolean;
}

export const DEFAULT_WEIGHTS: RetentionWeights = {
  ...RETENTION_WEIGHTS,
  recency_halflife_days: RECENCY_HALFLIFE_DAYS,
};

/**
 * Translate GET /config (engine truth, nested) into the lib's weight shape, so the
 * client estimate stays in lockstep with the server. Falls back to documented
 * defaults when no config is available.
 */
export function weightsFromConfig(
  cfg: ConfigResponse | null | undefined,
): RetentionWeights {
  if (!cfg) return DEFAULT_WEIGHTS;
  return {
    w_salience: cfg.weights.salience,
    w_reinforcement: cfg.weights.reinforcement,
    w_recency: cfg.weights.recency,
    recency_halflife_days: cfg.recency_halflife_days,
  };
}

/** Translate GET /config into the lib's threshold shape (nested → flat). */
export function thresholdsFromConfig(
  cfg: ConfigResponse | null | undefined,
): RetentionThresholds {
  if (!cfg) return RETENTION_THRESHOLDS;
  return {
    dormant_retention_max: cfg.thresholds.dormant_retention_max,
    archive_retention_max: cfg.thresholds.archive_retention_max,
    prune_salience_max: cfg.prune.salience_max,
  };
}

function recencyAt(days: number, halflife: number): number {
  return Math.pow(0.5, days / halflife);
}

function reinforcementOf(count: number): number {
  return 1 - 1 / (1 + count);
}

/** The raw retention score for an arbitrary recency value (used for cliff solving). */
function scoreFromComponents(
  salience: number,
  reinforcement: number,
  recency: number,
  w: RetentionWeights,
): number {
  const raw =
    w.w_salience * salience +
    w.w_reinforcement * reinforcement +
    w.w_recency * recency;
  const total = w.w_salience + w.w_reinforcement + w.w_recency;
  return total ? raw / total : 0;
}

function referenceMs(belief: Belief, nowMs: number): number {
  const ref = belief.last_accessed_at ?? belief.created_at;
  return ref ? Date.parse(ref) : nowMs;
}

/**
 * Solve for the number of days (from the current reference age) at which the score
 * crosses `threshold`, holding salience + reinforcement fixed and decaying recency.
 *
 *   score(days) = (w_sal*sal + w_reinf*reinf + w_rec * 0.5**(days/hl)) / total
 *   threshold   = ...  =>  recency* = (threshold*total - w_sal*sal - w_reinf*reinf)/w_rec
 *
 * Returns absolute days-from-reference, or null if even recency=1 is already below
 * threshold (already demotable) or recency can never push it below (never demotes).
 */
function daysToCross(
  salience: number,
  reinforcement: number,
  threshold: number,
  w: RetentionWeights,
): number | null {
  const total = w.w_salience + w.w_reinforcement + w.w_recency;
  if (!total || w.w_recency <= 0) return null;
  const targetRecency =
    (threshold * total - w.w_salience * salience - w.w_reinforcement * reinforcement) /
    w.w_recency;
  // recency in (0,1]. If target >= 1, the belief is at/below threshold already.
  if (targetRecency >= 1) return 0;
  // If target <= 0, recency can never reach it — belief never demotes on recency alone.
  if (targetRecency <= 0) return null;
  // 0.5**(days/hl) = targetRecency  =>  days = hl * log2(1/targetRecency)
  return w.recency_halflife_days * Math.log2(1 / targetRecency);
}

export function estimateRetention(
  belief: Belief,
  now: Date | number = Date.now(),
  weights: RetentionWeights = DEFAULT_WEIGHTS,
  thresholds: RetentionThresholds = RETENTION_THRESHOLDS,
): RetentionEstimate {
  const nowMs = typeof now === "number" ? now : now.getTime();
  const refMs = referenceMs(belief, nowMs);
  const days = Math.max(0, (nowMs - refMs) / MS_PER_DAY);

  const recency = recencyAt(days, weights.recency_halflife_days);
  const reinforcement = reinforcementOf(belief.reinforcement_count);
  const score = scoreFromComponents(belief.salience, reinforcement, recency, weights);

  // One-step demotion (mirrors apply_retention: archived is terminal here).
  let nextTier: TierName = belief.tier;
  if (belief.tier === "active" && score < thresholds.dormant_retention_max) {
    nextTier = "dormant";
  } else if (belief.tier === "dormant" && score < thresholds.archive_retention_max) {
    nextTier = "archived";
  }
  const willDemote = nextTier !== belief.tier;

  // Distance (in days from now) to the NEXT cliff this belief faces.
  let daysToNextDemotion: number | null = null;
  if (belief.tier === "active" || belief.tier === "dormant") {
    const threshold =
      belief.tier === "active"
        ? thresholds.dormant_retention_max
        : thresholds.archive_retention_max;
    const crossDaysFromRef = daysToCross(
      belief.salience,
      reinforcement,
      threshold,
      weights,
    );
    if (crossDaysFromRef !== null) {
      daysToNextDemotion = Math.max(0, crossDaysFromRef - days);
    }
  }

  const pruneEligible =
    belief.tier === "archived" &&
    belief.salience <= thresholds.prune_salience_max &&
    belief.last_accessed_at == null;

  return {
    score,
    recency,
    reinforcement,
    salience: belief.salience,
    daysSinceReference: days,
    nextTier,
    willDemote,
    daysToNextDemotion,
    pruneEligible,
  };
}
