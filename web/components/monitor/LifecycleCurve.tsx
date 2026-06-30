"use client";

/**
 * LifecycleCurve — the FORMATION ▲ / FORGETTING ▼ time-series from the Mind Monitor mockup.
 *
 * A dependency-free SVG line chart of how many beliefs are HELD (active) over time, with
 * Grafana-style vertical event annotations dropped onto the x-axis (formed / contradicted /
 * superseded / retrieve / demote / prune …). It is the macro counterpart to the inspector's
 * per-belief BeliefTimeline: this watches the whole population breathe.
 *
 * PRESENTATIONAL. All data arrives via props — the parent (Mind Monitor) is responsible for
 * bucketing /beliefs?all=true snapshots and stitching POST-response/timeline events into the
 * `points` series and `annotations`. This component owns only geometry + paint, importing
 * solely from lib/* (tokens) and components/primitives (Mono). It touches no barrel/shared file.
 *
 * Honesty constraints honored at the paint layer:
 *   - Annotation kinds are limited to the real grammar surfaced by lib/events.EventKind plus
 *     the synthetic "retrieve" (a touch(), not a belief event). There is NO "branched": a
 *     branch is the `contradicted`+detail.kind="branch" row the caller passes as kind="branch".
 *   - A supersede's contradicted+superseded pair must already be de-duped by the caller
 *     (lib/events.collapseSupersede) before being handed in — we paint one mark per act.
 *   - PRUNED has no event; the caller reconstructs it via snapshot-diff (lib/events.diffPruned)
 *     and passes it as kind="pruned". We never invent one.
 *   - The "held" series is a real population count, not an estimate, so it carries no "est"
 *     label; the retention ESTIMATE lives in RetentionHistogram, not here.
 */

import * as React from "react";

import type { EventKind } from "@/lib/events";
import { EVENT_COLOR, EVENT_GLYPH } from "@/lib/tokens";
import { Mono } from "@/components/primitives";

// ---------------------------------------------------------------------------
// kinds + palette
// ---------------------------------------------------------------------------

/**
 * The annotation kinds this curve can paint. A superset of the real belief EventKind with
 * one synthetic verb — "retrieve" — which is a touch()/warm-up, not a BeliefEvent. (There is
 * deliberately no "branched": branches arrive as kind="branch".)
 */
export type CurveAnnotationKind = EventKind | "retrieve";

/** Retrieve is a touch(), not a belief event — give it the accent hue + a warming arrow. */
const RETRIEVE_COLOR = "#4ED8C4";
const RETRIEVE_GLYPH = "↑"; // ↑ (warm-up)

function annotationColor(kind: CurveAnnotationKind): string {
  if (kind === "retrieve") return RETRIEVE_COLOR;
  if (kind === "branch") return EVENT_COLOR.contradicted;
  return EVENT_COLOR[kind as keyof typeof EVENT_COLOR] ?? "#9AA3AF";
}

function annotationGlyph(kind: CurveAnnotationKind): string {
  if (kind === "retrieve") return RETRIEVE_GLYPH;
  if (kind === "branch") return EVENT_GLYPH.contradicted;
  return EVENT_GLYPH[kind as keyof typeof EVENT_GLYPH] ?? "•";
}

// ---------------------------------------------------------------------------
// props
// ---------------------------------------------------------------------------

/** One sample of the held (active) population at an instant. */
export interface LifecyclePoint {
  /** epoch ms (or any monotonically-increasing x — labels assume ms). */
  t: number;
  /** count of beliefs HELD (active tier) at that instant. */
  held: number;
}

/** A Grafana-style vertical annotation dropped on the x-axis at instant `t`. */
export interface LifecycleAnnotation {
  /** stable key (event id, or a synthesized retrieve id). */
  id: string | number;
  /** epoch ms — x position. */
  t: number;
  /** which verb — drives hue + glyph. */
  kind: CurveAnnotationKind;
  /** short caption shown above the rule (e.g. the belief statement, truncated). */
  label?: string;
}

export interface LifecycleCurveProps {
  /** Held-count time-series (need >= 1 point to draw; 0 points → empty state). */
  points: LifecyclePoint[];
  /** Vertical event annotations to drop onto the timeline. */
  annotations?: LifecycleAnnotation[];
  /**
   * The NOW instant (epoch ms). Painted as a bright vertical cursor; future region
   * (t > now) is dimmed. When omitted, the last point's t is used.
   */
  now?: number;
  /** Recency halflife in days, shown in the header chip (default 14, from retention.ts). */
  halflifeDays?: number;
  /** Optional fixed x-domain [minT, maxT]; defaults to the data + annotation extent. */
  domain?: [number, number];
  /** Optional fixed y-max for held; defaults to max(held)+headroom. */
  yMax?: number;
  /** Outer pixel height of the plot (excludes header). Width is fluid (viewBox). */
  height?: number;
  /** Highlight a single annotation/belief (renders its mark filled + ●). */
  selectedId?: string | number | null;
  /** Click an annotation mark. */
  onSelectAnnotation?: (a: LifecycleAnnotation) => void;
  className?: string;
}

// ---------------------------------------------------------------------------
// geometry constants (viewBox space — the SVG scales to its container width)
// ---------------------------------------------------------------------------

const VB_W = 720; // viewBox width units
const PAD_L = 34; // left gutter for y ticks
const PAD_R = 12;
const PAD_T = 22; // top room for annotation captions
const PAD_B = 26; // bottom room for x labels + glyph row

function niceMax(v: number): number {
  if (v <= 0) return 4;
  if (v <= 4) return 4;
  if (v <= 8) return 8;
  if (v <= 12) return 12;
  if (v <= 16) return 16;
  return Math.ceil(v / 8) * 8;
}

/** Compact UTC month label, e.g. "Jun". */
function fmtMonth(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
}

/** Compact UTC day stamp, e.g. "Jun 20". */
function fmtDay(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Build evenly-spaced x ticks across the domain (months-ish, max ~6 ticks). */
function xTicks(min: number, max: number, count = 5): number[] {
  if (!(max > min)) return [min];
  const out: number[] = [];
  for (let i = 0; i <= count; i++) out.push(min + ((max - min) * i) / count);
  return out;
}

// ---------------------------------------------------------------------------
// component
// ---------------------------------------------------------------------------

export function LifecycleCurve({
  points,
  annotations = [],
  now,
  halflifeDays = 14,
  domain,
  yMax,
  height = 200,
  selectedId = null,
  onSelectAnnotation,
  className = "",
}: LifecycleCurveProps) {
  const sorted = React.useMemo(
    () => [...points].sort((a, b) => a.t - b.t),
    [points],
  );

  const plot = React.useMemo(() => {
    const ts = sorted.map((p) => p.t);
    const annTs = annotations.map((a) => a.t);
    const allTs = [...ts, ...annTs];
    if (now != null) allTs.push(now);

    const minT = domain ? domain[0] : allTs.length ? Math.min(...allTs) : 0;
    const maxTRaw = domain ? domain[1] : allTs.length ? Math.max(...allTs) : 1;
    const maxT = maxTRaw > minT ? maxTRaw : minT + 1;

    const maxHeld = sorted.length ? Math.max(...sorted.map((p) => p.held)) : 0;
    const yHi = yMax ?? niceMax(maxHeld);

    const innerW = VB_W - PAD_L - PAD_R;
    const innerH = height - PAD_T - PAD_B;

    const x = (t: number) =>
      PAD_L + ((t - minT) / (maxT - minT)) * innerW;
    const y = (v: number) =>
      PAD_T + innerH - (Math.min(v, yHi) / (yHi || 1)) * innerH;

    return { minT, maxT, yHi, innerW, innerH, x, y };
  }, [sorted, annotations, now, domain, yMax, height]);

  const nowMs = now ?? (sorted.length ? sorted[sorted.length - 1].t : plot.maxT);

  // line + area paths over the held series
  const paths = React.useMemo(() => {
    if (sorted.length === 0) return { line: "", area: "" };
    const pts = sorted.map((p) => [plot.x(p.t), plot.y(p.held)] as const);
    const line = pts
      .map(([px, py], i) => `${i === 0 ? "M" : "L"} ${px.toFixed(1)} ${py.toFixed(1)}`)
      .join(" ");
    const baseY = (PAD_T + plot.innerH).toFixed(1);
    const area =
      pts.length > 1
        ? `M ${pts[0][0].toFixed(1)} ${baseY} ` +
          pts.map(([px, py]) => `L ${px.toFixed(1)} ${py.toFixed(1)}`).join(" ") +
          ` L ${pts[pts.length - 1][0].toFixed(1)} ${baseY} Z`
        : "";
    return { line, area };
  }, [sorted, plot]);

  // y gridline values (0, mid, max)
  const yGrid = React.useMemo(() => {
    const hi = plot.yHi;
    return [0, Math.round(hi / 2), hi];
  }, [plot.yHi]);

  const xTickVals = React.useMemo(
    () => xTicks(plot.minT, plot.maxT, 5),
    [plot.minT, plot.maxT],
  );

  const nowX = plot.x(nowMs);

  // ---- empty state (no series at all) ----
  if (sorted.length === 0) {
    return (
      <div className={className}>
        <Header halflifeDays={halflifeDays} />
        <div className="flex items-center justify-center rounded-md border border-dashed border-border bg-surface-0 px-6 py-10 text-center">
          <Mono faint className="text-xs">
            no population history yet &middot; run learn / maintain on the scratch session
          </Mono>
        </div>
      </div>
    );
  }

  return (
    <div className={className}>
      <Header halflifeDays={halflifeDays} />

      <svg
        viewBox={`0 0 ${VB_W} ${height}`}
        width="100%"
        height={height}
        preserveAspectRatio="none"
        role="img"
        aria-label="Formation and forgetting of held beliefs over time"
        style={{ display: "block" }}
      >
        {/* ---- future region shading (t > now) ---- */}
        {nowX < PAD_L + plot.innerW ? (
          <rect
            x={Math.max(PAD_L, nowX)}
            y={PAD_T}
            width={Math.max(0, PAD_L + plot.innerW - Math.max(PAD_L, nowX))}
            height={plot.innerH}
            fill="#0A0B0D"
            opacity={0.45}
          />
        ) : null}

        {/* ---- y gridlines + ticks ---- */}
        {yGrid.map((v) => {
          const gy = plot.y(v);
          return (
            <g key={`y-${v}`}>
              <line
                x1={PAD_L}
                y1={gy}
                x2={PAD_L + plot.innerW}
                y2={gy}
                stroke="#2A2F38"
                strokeWidth={1}
                strokeDasharray={v === 0 ? undefined : "2 4"}
                opacity={v === 0 ? 1 : 0.6}
              />
              <text
                x={PAD_L - 6}
                y={gy + 3}
                textAnchor="end"
                className="mono"
                fontSize={9}
                fill="#5B6470"
              >
                {v}
              </text>
            </g>
          );
        })}

        {/* ---- x ticks (month labels) ---- */}
        {xTickVals.map((t, i) => {
          const tx = plot.x(t);
          const span = plot.maxT - plot.minT;
          const label = span > 1000 * 60 * 60 * 24 * 40 ? fmtMonth(t) : fmtDay(t);
          return (
            <text
              key={`x-${i}`}
              x={tx}
              y={height - 14}
              textAnchor="middle"
              className="mono"
              fontSize={9}
              fill="#5B6470"
            >
              {label}
            </text>
          );
        })}

        {/* ---- vertical event annotations (Grafana-style rules) ---- */}
        {annotations.map((a) => {
          const ax = plot.x(a.t);
          if (ax < PAD_L - 0.5 || ax > PAD_L + plot.innerW + 0.5) return null;
          const color = annotationColor(a.kind);
          const selected = selectedId != null && a.id === selectedId;
          const future = a.t > nowMs;
          return (
            <g
              key={`ann-${a.id}`}
              opacity={future ? 0.5 : 1}
              style={{ cursor: onSelectAnnotation ? "pointer" : "default" }}
              onClick={
                onSelectAnnotation ? () => onSelectAnnotation(a) : undefined
              }
            >
              <line
                x1={ax}
                y1={PAD_T}
                x2={ax}
                y2={PAD_T + plot.innerH}
                stroke={color}
                strokeWidth={selected ? 1.5 : 1}
                strokeDasharray="3 3"
                opacity={selected ? 0.9 : 0.55}
              />
              {/* glyph badge at the axis foot */}
              <circle
                cx={ax}
                cy={PAD_T + plot.innerH}
                r={selected ? 4.5 : 3.2}
                fill={selected ? color : "#0A0B0D"}
                stroke={color}
                strokeWidth={1.4}
              />
              {/* hit target */}
              {onSelectAnnotation ? (
                <rect
                  x={ax - 6}
                  y={PAD_T}
                  width={12}
                  height={plot.innerH}
                  fill="transparent"
                >
                  <title>
                    {annotationGlyph(a.kind)} {a.kind}
                    {a.label ? ` — ${a.label}` : ""} @ {fmtDay(a.t)}
                  </title>
                </rect>
              ) : (
                <title>
                  {annotationGlyph(a.kind)} {a.kind}
                  {a.label ? ` — ${a.label}` : ""} @ {fmtDay(a.t)}
                </title>
              )}
            </g>
          );
        })}

        {/* ---- the held curve (formation rises ▲ / forgetting falls ▼) ---- */}
        {paths.area ? (
          <path d={paths.area} fill="#4ED8C4" opacity={0.1} />
        ) : null}
        {paths.line ? (
          <path
            d={paths.line}
            fill="none"
            stroke="#4ED8C4"
            strokeWidth={1.75}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ) : null}

        {/* ---- the now cursor ---- */}
        {nowX >= PAD_L - 0.5 && nowX <= PAD_L + plot.innerW + 0.5 ? (
          <g>
            <line
              x1={nowX}
              y1={PAD_T - 4}
              x2={nowX}
              y2={PAD_T + plot.innerH}
              stroke="#7FF0E0"
              strokeWidth={1.25}
            />
            <polygon
              points={`${nowX - 3},${PAD_T - 4} ${nowX + 3},${PAD_T - 4} ${nowX},${PAD_T + 1}`}
              fill="#7FF0E0"
            />
          </g>
        ) : null}
      </svg>

      {/* ---- annotation glyph legend strip (DOM, for crisp mono glyphs + a11y) ---- */}
      <AnnotationStrip
        annotations={annotations}
        nowMs={nowMs}
        selectedId={selectedId}
        onSelectAnnotation={onSelectAnnotation}
      />

      {/* ---- footer: x range + held legend ---- */}
      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-1">
        <div className="flex items-center gap-1.5">
          <span
            className="inline-block rounded-full"
            style={{ width: 6, height: 6, backgroundColor: "#4ED8C4" }}
          />
          <Mono faint className="text-2xs">
            held (active) &middot; {fmtDay(plot.minT)} &rarr; {fmtDay(plot.maxT)}
          </Mono>
        </div>
        <Mono faint className="text-2xs">
          now&#9656; {fmtDay(nowMs)} &middot; &#9650; formation / &#9660; forgetting
        </Mono>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// header
// ---------------------------------------------------------------------------

function Header({ halflifeDays }: { halflifeDays: number }) {
  return (
    <div className="mb-1 flex items-center justify-between border-b border-border px-1 pb-1.5">
      <Mono dim className="text-xs uppercase tracking-wide">
        Formation &#9650; / Forgetting &#9660;
      </Mono>
      <Mono faint className="text-2xs">
        halflife {halflifeDays}d
      </Mono>
    </div>
  );
}

// ---------------------------------------------------------------------------
// annotation strip — crisp DOM glyphs under the axis (mono truth)
// ---------------------------------------------------------------------------

function AnnotationStrip({
  annotations,
  nowMs,
  selectedId,
  onSelectAnnotation,
}: {
  annotations: LifecycleAnnotation[];
  nowMs: number;
  selectedId: string | number | null;
  onSelectAnnotation?: (a: LifecycleAnnotation) => void;
}) {
  if (annotations.length === 0) return null;
  const ordered = [...annotations].sort((a, b) => a.t - b.t);
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 px-1">
      {ordered.map((a) => {
        const color = annotationColor(a.kind);
        const glyph = annotationGlyph(a.kind);
        const selected = selectedId != null && a.id === selectedId;
        const future = a.t > nowMs;
        const interactive = !!onSelectAnnotation;
        const inner = (
          <>
            <Mono className="text-2xs leading-none" style={{ color }}>
              {glyph}
            </Mono>
            <Mono
              className="text-2xs lowercase"
              style={{ color: selected ? color : undefined }}
              dim={!selected}
            >
              {a.kind}
            </Mono>
            {a.label ? (
              <span className="max-w-[10rem] truncate font-sans text-2xs text-ink-dim">
                {a.label}
              </span>
            ) : null}
          </>
        );
        const baseCls =
          "inline-flex items-center gap-1 rounded px-1.5 py-0.5 " +
          (future ? "opacity-50 " : "") +
          (selected ? "bg-surface-2" : "");
        return interactive ? (
          <button
            key={`strip-${a.id}`}
            type="button"
            onClick={() => onSelectAnnotation?.(a)}
            className={`${baseCls} transition-colors hover:bg-surface-1`}
            style={selected ? { boxShadow: `inset 0 0 0 1px ${color}55` } : undefined}
            title={`${a.kind}${a.label ? ` — ${a.label}` : ""} @ ${fmtDay(a.t)}`}
          >
            {inner}
          </button>
        ) : (
          <span
            key={`strip-${a.id}`}
            className={baseCls}
            title={`${a.kind}${a.label ? ` — ${a.label}` : ""} @ ${fmtDay(a.t)}`}
          >
            {inner}
          </span>
        );
      })}
    </div>
  );
}

export default LifecycleCurve;
