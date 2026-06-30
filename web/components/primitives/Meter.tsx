import * as React from "react";
import { Mono } from "./Mono";

/**
 * A horizontal meter for a 0..1 float (confidence / salience / retention). Renders BOTH
 * the number (mono) and a filled bar — the value maps to width AND the bar's opacity, so
 * a 0.28 reads faint and a 0.91 reads heavy.
 *
 * Optional `markers` draw threshold ticks (e.g. the 0.15 / 0.35 retention cliffs).
 */
export interface MeterMarker {
  at: number; // 0..1 position
  label?: string;
  color?: string;
}

export function Meter({
  value,
  color = "#4ED8C4",
  label,
  showValue = true,
  digits = 2,
  markers,
  width = 88,
  className = "",
}: {
  value: number;
  color?: string;
  label?: string;
  showValue?: boolean;
  digits?: number;
  markers?: MeterMarker[];
  width?: number;
  className?: string;
}) {
  const v = Math.min(1, Math.max(0, value));
  const opacity = 0.32 + 0.68 * v;
  return (
    <span className={`inline-flex items-center gap-2 ${className}`.trim()}>
      {label ? (
        <Mono dim className="text-2xs uppercase tracking-wide">
          {label}
        </Mono>
      ) : null}
      <span
        className="relative inline-block rounded-sm bg-surface-3"
        style={{ width, height: 8 }}
        role="meter"
        aria-valuenow={v}
        aria-valuemin={0}
        aria-valuemax={1}
        aria-label={label}
      >
        <span
          className="absolute left-0 top-0 h-full rounded-sm"
          style={{ width: `${v * 100}%`, backgroundColor: color, opacity }}
        />
        {markers?.map((m, i) => (
          <span
            key={i}
            className="absolute top-[-2px] h-[12px] w-px"
            style={{
              left: `${Math.min(1, Math.max(0, m.at)) * 100}%`,
              backgroundColor: m.color ?? "#9AA3AF",
            }}
            title={m.label}
          />
        ))}
      </span>
      {showValue ? <Mono className="text-2xs">{v.toFixed(digits)}</Mono> : null}
    </span>
  );
}
