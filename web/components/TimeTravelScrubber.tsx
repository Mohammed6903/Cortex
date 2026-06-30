"use client";

/**
 * TimeTravelScrubber — the global `now`-slider of the Mind Monitor.
 *
 * Dragging the handle sets the shared `now` cursor (useSession().setNow). The Mind Monitor
 * page already threads that `now` into TierLadder / RetentionHistogram / LifecycleCurve and
 * the client retention estimate, so every panel live-updates as you scrub. When you issue a
 * verb (learn/maintain/retrieve) the page passes this same `now` as ISO into the route — all
 * three accept it and run against the SCRATCH db (never the live store, honesty constraint #2).
 *
 * It also drives scenario REPLAY: picking a scenario calls POST /session/reset {scenario},
 * which the page handler re-seeds + refetches from. The rail's domain spans the seeded
 * beliefs' validity history so the labelled ticks (first-formed … now) line up with the data.
 *
 * Honesty:
 *   - This is the scratch session's clock, labelled "scratch only". Nothing here touches a
 *     real store.
 *   - The cursor is a *query* time, not a mutation: scrubbing alone changes only the client
 *     estimate; consequences (demote/prune/promote) require an explicit learn/maintain/retrieve
 *     at that `now`, which the buttons issue through the page.
 */

import * as React from "react";
import { Clock, Play, Pause, RotateCcw } from "lucide-react";

import { Mono } from "@/components/primitives";
import { useSession } from "@/components/SessionContext";
import { SCENARIOS, scenarioMeta } from "@/lib/session";

const MS_PER_DAY = 86_400_000;

export interface TimeTravelScrubberProps {
  /**
   * Time domain the rail spans, as epoch ms. Typically [earliest belief formation, now].
   * The page derives it from the seeded beliefs so ticks line up with the data.
   */
  domainStart: number;
  domainEnd: number;
  /** Currently-seeded scenario (drives the replay select + label). */
  scenario: string | null;
  /** Replay a scenario: POST /session/reset {scenario} then refetch (page-owned). */
  onReplay: (scenario: string) => void | Promise<void>;
  /** Issue a learn at the current `now` against the scratch db (page-owned refresh). */
  onLearn?: () => void | Promise<void>;
  /** Issue a maintain at the current `now` (page-owned snapshot-diff for prunes). */
  onMaintain?: () => void | Promise<void>;
  className?: string;
}

function fmtClock(d: Date): string {
  const iso = d.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function fmtTick(ms: number): string {
  const iso = new Date(ms).toISOString();
  // e.g. "Jan10" — compact month+day for the rail end-labels
  const month = iso.slice(5, 7);
  const day = iso.slice(8, 10);
  const MONTHS = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${MONTHS[parseInt(month, 10) - 1] ?? month}${day}`;
}

/** Map a value in [start,end] to a 0..1 fraction (clamped). */
function fraction(value: number, start: number, end: number): number {
  if (end <= start) return 1;
  return Math.min(1, Math.max(0, (value - start) / (end - start)));
}

export function TimeTravelScrubber({
  domainStart,
  domainEnd,
  scenario,
  onReplay,
  onLearn,
  onMaintain,
  className = "",
}: TimeTravelScrubberProps) {
  const { now, setNow } = useSession();
  const railRef = React.useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const [playing, setPlaying] = React.useState(false);
  const [busy, setBusy] = React.useState<"replay" | "learn" | "maintain" | null>(null);

  // guard against a degenerate domain (single instant) — pad to one day either side.
  const start = domainStart;
  const end = domainEnd > domainStart ? domainEnd : domainStart + MS_PER_DAY;
  const span = end - start;

  const nowMs = now.getTime();
  const pct = fraction(nowMs, start, end) * 100;

  // ---- drag handling: pointer x → now ----
  const setNowFromClientX = React.useCallback(
    (clientX: number) => {
      const rail = railRef.current;
      if (!rail) return;
      const rect = rail.getBoundingClientRect();
      const f = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
      const t = start + Math.min(1, Math.max(0, f)) * span;
      setNow(new Date(Math.round(t)));
    },
    [start, span, setNow],
  );

  React.useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => setNowFromClientX(e.clientX);
    const onUp = () => setDragging(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragging, setNowFromClientX]);

  // ---- play: animate the cursor forward across the domain (one pass) ----
  React.useEffect(() => {
    if (!playing) return;
    // sweep the remaining span over ~6s, regardless of current position.
    const durationMs = 6000;
    const startedAt = performance.now();
    const fromMs = now.getTime();
    let raf = 0;
    const tick = (t: number) => {
      const elapsed = t - startedAt;
      const f = Math.min(1, elapsed / durationMs);
      const target = fromMs + (end - fromMs) * f;
      setNow(new Date(Math.round(target)));
      if (f < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        setPlaying(false);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // intentionally NOT depending on `now` — we snapshot fromMs once per play.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, end, setNow]);

  const meta = scenarioMeta(scenario);

  async function run(
    label: "replay" | "learn" | "maintain",
    fn: (() => void | Promise<void>) | undefined,
    arg?: string,
  ) {
    if (!fn) return;
    setBusy(label);
    try {
      if (label === "replay" && arg) await onReplay(arg);
      else await fn();
    } finally {
      setBusy(null);
    }
  }

  return (
    <section
      className={`rounded-md border border-border bg-surface-0 px-4 py-3 ${className}`.trim()}
      aria-label="Time-travel scrubber"
    >
      {/* header row: label · scenario replay · now readout · verbs */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <Clock size={13} className="text-accent" aria-hidden />
          <Mono dim className="text-2xs uppercase tracking-widest">
            time-travel
          </Mono>
          <Mono faint className="text-2xs">
            · scratch only
          </Mono>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* scenario replay select */}
          <label className="flex items-center gap-1.5">
            <Mono dim className="text-2xs">
              replay
            </Mono>
            <select
              value={scenario ?? ""}
              disabled={busy !== null}
              onChange={(e) => {
                const next = e.target.value;
                if (next) void run("replay", () => onReplay(next), next);
              }}
              className="mono rounded border border-border bg-surface-1 px-2 py-1 text-2xs text-ink outline-none transition-colors hover:border-accent/50 focus:border-accent/70 disabled:opacity-50"
            >
              {scenario == null ? <option value="">(empty)</option> : null}
              {SCENARIOS.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>

          {/* now readout */}
          <Mono dim className="text-2xs">
            now ▸ {fmtClock(now)}
          </Mono>

          {/* reset cursor to wall clock */}
          <button
            type="button"
            onClick={() => {
              setPlaying(false);
              setNow(new Date());
            }}
            className="inline-flex items-center gap-1 rounded border border-border bg-surface-1 px-2 py-1 text-ink-dim transition-colors hover:border-accent/60 hover:text-ink"
            title="reset now-cursor to wall clock"
          >
            <RotateCcw size={11} aria-hidden />
            <Mono className="text-2xs">now</Mono>
          </button>
        </div>
      </div>

      {/* scenario blurb */}
      {meta ? (
        <p className="mt-1.5 font-sans text-2xs leading-relaxed text-ink-faint">
          {meta.blurb}
        </p>
      ) : null}

      {/* the rail */}
      <div className="mt-3 flex items-center gap-3">
        {/* play / pause sweeps the cursor forward across the domain */}
        <button
          type="button"
          onClick={() => setPlaying((v) => !v)}
          className="inline-flex h-6 w-6 items-center justify-center rounded border border-border bg-surface-1 text-ink-dim transition-colors hover:border-accent/60 hover:text-accent"
          title={playing ? "pause" : "play — sweep now forward"}
          aria-pressed={playing}
        >
          {playing ? <Pause size={12} /> : <Play size={12} />}
        </button>

        <div className="relative flex-1 select-none py-2">
          {/* track */}
          <div
            ref={railRef}
            role="slider"
            aria-label="now cursor"
            aria-valuemin={start}
            aria-valuemax={end}
            aria-valuenow={Math.round(nowMs)}
            tabIndex={0}
            onPointerDown={(e) => {
              (e.target as Element).setPointerCapture?.(e.pointerId);
              setPlaying(false);
              setDragging(true);
              setNowFromClientX(e.clientX);
            }}
            onKeyDown={(e) => {
              // arrow keys nudge the cursor by a day
              if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                e.preventDefault();
                const step = (e.key === "ArrowRight" ? 1 : -1) * MS_PER_DAY;
                const t = Math.min(end, Math.max(start, nowMs + step));
                setNow(new Date(Math.round(t)));
              }
            }}
            className="relative h-1.5 w-full cursor-pointer rounded-full bg-surface-2"
          >
            {/* filled portion up to the cursor */}
            <span
              className="absolute left-0 top-0 h-full rounded-full"
              style={{
                width: `${pct}%`,
                backgroundColor: "#4ED8C455",
              }}
              aria-hidden
            />
            {/* the cursor handle */}
            <span
              className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-canvas"
              style={{
                left: `${pct}%`,
                backgroundColor: "#4ED8C4",
                boxShadow: dragging ? "0 0 10px #4ED8C499" : "none",
              }}
              aria-hidden
            />
          </div>

          {/* end-tick labels */}
          <div className="mt-1.5 flex items-center justify-between">
            <Mono faint className="text-2xs">
              {fmtTick(start)}
            </Mono>
            <Mono faint className="text-2xs">
              drag → drives /learn /maintain /retrieve now=…
            </Mono>
            <Mono faint className="text-2xs">
              now▸{fmtTick(end)}
            </Mono>
          </div>
        </div>

        {/* run verbs at the current cursor */}
        <div className="flex items-center gap-1.5">
          {onLearn ? (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void run("learn", onLearn)}
              className="rounded border border-border bg-surface-1 px-2 py-1 text-ink-dim transition-colors hover:border-accent/60 hover:text-ink disabled:opacity-50"
              title="POST /learn now=… (scratch)"
            >
              <Mono className="text-2xs">{busy === "learn" ? "…" : "learn"}</Mono>
            </button>
          ) : null}
          {onMaintain ? (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void run("maintain", onMaintain)}
              className="rounded border border-border bg-surface-1 px-2 py-1 text-ink-dim transition-colors hover:border-accent/60 hover:text-ink disabled:opacity-50"
              title="POST /maintain now=… (scratch · snapshot-diff for prunes)"
            >
              <Mono className="text-2xs">{busy === "maintain" ? "…" : "maintain"}</Mono>
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
