import * as React from "react";
import type { BeliefEventTypeName, BeliefTypeName, TierName } from "@/lib/api";
import {
  EVENT_COLOR,
  EVENT_GLYPH,
  EVENT_LABEL,
  TIER_COLOR,
  TIER_LABEL,
  TYPE_LABEL,
} from "@/lib/tokens";
import { Mono } from "./Mono";

type TierVariant = { variant: "tier"; value: TierName | "pruned" };
type TypeVariant = { variant: "type"; value: BeliefTypeName };
type EventVariant = { variant: "event"; value: BeliefEventTypeName; glyph?: boolean };

type BadgeProps = (TierVariant | TypeVariant | EventVariant) & {
  className?: string;
};

/**
 * One badge primitive, three variants:
 *  - tier  → colored dot + tier name (active=cyan / dormant=amber / archived=slate /
 *            pruned=outline-only tombstone)
 *  - type  → neutral pill of the belief type grammar
 *  - event → event-verb hue + glyph + verb (formed/reinforced/contradicted/…)
 */
export function Badge(props: BadgeProps) {
  const { className = "" } = props;

  if (props.variant === "tier") {
    const color = TIER_COLOR[props.value];
    const isPruned = props.value === "pruned";
    return (
      <span
        className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 ${className}`.trim()}
        style={{
          borderColor: isPruned ? color : `${color}55`,
          backgroundColor: isPruned ? "transparent" : `${color}14`,
        }}
      >
        {isPruned ? (
          <span
            className="inline-block h-2 w-2 rounded-full border"
            style={{ borderColor: color }}
          />
        ) : (
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: color }}
          />
        )}
        <Mono className="text-2xs uppercase tracking-wide" style={{ color }}>
          {TIER_LABEL[props.value]}
        </Mono>
      </span>
    );
  }

  if (props.variant === "type") {
    return (
      <span
        className={`inline-flex items-center rounded-full border border-border bg-surface-2 px-2 py-0.5 ${className}`.trim()}
      >
        <Mono dim className="text-2xs uppercase tracking-wide">
          {TYPE_LABEL[props.value]}
        </Mono>
      </span>
    );
  }

  // event
  const color = EVENT_COLOR[props.value];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 ${className}`.trim()}
      style={{ backgroundColor: `${color}1A` }}
    >
      {props.glyph !== false ? (
        <Mono style={{ color }} className="text-2xs leading-none">
          {EVENT_GLYPH[props.value]}
        </Mono>
      ) : null}
      <Mono className="text-2xs lowercase" style={{ color }}>
        {EVENT_LABEL[props.value]}
      </Mono>
    </span>
  );
}
