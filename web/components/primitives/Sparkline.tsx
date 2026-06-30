import * as React from "react";

/**
 * A tiny dependency-free SVG sparkline. No charting lib — just a polyline (and optional
 * area fill) over a 0..1-normalized series. Used for confidence-over-time / formation
 * curves in dense rows. `markers` drop colored dots on specific indices (event annotations).
 */
export interface SparkMarker {
  index: number;
  color: string;
  label?: string;
}

export function Sparkline({
  values,
  width = 96,
  height = 24,
  color = "#4ED8C4",
  fill = false,
  strokeWidth = 1.25,
  markers,
  min,
  max,
  className = "",
}: {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
  fill?: boolean;
  strokeWidth?: number;
  markers?: SparkMarker[];
  min?: number;
  max?: number;
  className?: string;
}) {
  if (values.length === 0) {
    return <svg width={width} height={height} className={className} aria-hidden />;
  }
  const lo = min ?? Math.min(...values);
  const hi = max ?? Math.max(...values);
  const span = hi - lo || 1;
  const pad = strokeWidth;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;

  const pt = (v: number, i: number): [number, number] => {
    const x =
      values.length === 1 ? pad + innerW / 2 : pad + (i / (values.length - 1)) * innerW;
    const y = pad + innerH - ((v - lo) / span) * innerH;
    return [x, y];
  };

  const points = values.map(pt);
  const line = points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const areaPath =
    fill && points.length > 1
      ? `M ${points[0][0].toFixed(2)},${(height - pad).toFixed(2)} ` +
        points.map(([x, y]) => `L ${x.toFixed(2)},${y.toFixed(2)}`).join(" ") +
        ` L ${points[points.length - 1][0].toFixed(2)},${(height - pad).toFixed(2)} Z`
      : null;

  return (
    <svg
      width={width}
      height={height}
      className={className}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden
    >
      {areaPath ? <path d={areaPath} fill={color} opacity={0.12} /> : null}
      <polyline
        points={line}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {markers?.map((m, i) => {
        const [x, y] = pt(values[m.index] ?? 0, m.index);
        return (
          <circle key={i} cx={x} cy={y} r={2.2} fill={m.color}>
            {m.label ? <title>{m.label}</title> : null}
          </circle>
        );
      })}
    </svg>
  );
}
