/**
 * Design tokens as TS maps + helpers. Keep these in lockstep with tailwind.config.ts.
 *
 * confidence & salience map to BOTH a number AND opacity/weight — a 0.28 belief literally
 * fades; a 0.91 reads heavy. Use opacityFromConfidence / weightFromConfidence for that.
 */

import type { BeliefEventTypeName, BeliefTypeName, TierName } from "./api";

// ---- tier ramp ----

export const TIER_COLOR: Record<TierName | "pruned", string> = {
  active: "#4ED8C4",
  dormant: "#E0A458",
  archived: "#5B6470",
  pruned: "#5B6470",
};

export const TIER_LABEL: Record<TierName | "pruned", string> = {
  active: "active",
  dormant: "dormant",
  archived: "archived",
  pruned: "pruned",
};

// ---- event-verb hues (muted) ----

export const EVENT_COLOR: Record<BeliefEventTypeName, string> = {
  formed: "#4ED8C4",
  reinforced: "#5FB87A",
  contradicted: "#D86A6A",
  superseded: "#D86A6A",
  merged: "#9B7FD8",
  demoted: "#E0A458",
  promoted: "#7FF0E0",
  pruned: "#5B6470",
};

/** Single-glyph event markers used in the stream + git gutter. */
export const EVENT_GLYPH: Record<BeliefEventTypeName, string> = {
  formed: "✦",
  reinforced: "⤴",
  contradicted: "⎇",
  superseded: "⊝",
  merged: "⋈",
  demoted: "▽",
  promoted: "△",
  pruned: "⌦",
};

export const EVENT_LABEL: Record<BeliefEventTypeName, string> = {
  formed: "formed",
  reinforced: "reinforced",
  contradicted: "contradicted",
  superseded: "superseded",
  merged: "merged",
  demoted: "demoted",
  promoted: "promoted",
  pruned: "pruned",
};

// ---- belief-type grammar ----

export const TYPE_LABEL: Record<BeliefTypeName, string> = {
  preference: "preference",
  fact: "fact",
  goal: "goal",
  relationship: "relationship",
  transient_state: "transient",
};

// ---- confidence/salience -> visual weight ----

/**
 * Map a 0..1 confidence/salience to an opacity floor of 0.32 so even faint beliefs
 * stay legible, ramping to full 1.0 at confidence 1. A 0.28 belief reads ~0.51 opacity.
 */
export function opacityFromConfidence(value: number): number {
  const v = Math.min(1, Math.max(0, value));
  return 0.32 + 0.68 * v;
}

/**
 * Map a 0..1 confidence to a font-weight bucket. Inter ships 300/400/510-emphasis,
 * so we return one of those weights — heavy beliefs read heavy.
 */
export function weightFromConfidence(value: number): 300 | 400 | 500 {
  const v = Math.min(1, Math.max(0, value));
  if (v >= 0.8) return 500;
  if (v >= 0.5) return 400;
  return 300;
}

/** Tailwind border/text class helper for a tier (inline styles are used for exact hex). */
export function tierColor(tier: TierName | "pruned"): string {
  return TIER_COLOR[tier];
}

export function eventColor(type: BeliefEventTypeName): string {
  return EVENT_COLOR[type];
}

/** Format a 0..1 float as a fixed-2 machine value, e.g. 0.80. */
export function fmtFloat(value: number, digits = 2): string {
  return value.toFixed(digits);
}
