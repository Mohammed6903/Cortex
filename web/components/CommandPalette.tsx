"use client";

/**
 * CommandPalette (⌘K) — the keyboard verb-runner that mirrors the Cortex CLI.
 *
 * Verbs (each optionally reproducible via a `now` field that threads into the route):
 *   ingest          — POST /ingest a quick note episode (source=notes kind=entry)
 *   learn           — POST /learn  now=…   reconcile pending episodes into beliefs
 *   maintain        — POST /maintain now=… run retention (demote/merge/prune)
 *   retrieve <q>    — POST /retrieve query=… now=…  (the warm-up interaction's verb)
 *   replay <scen>   — POST /session/reset {scenario} then refetch
 *   inspect <id>    — navigate to /belief/<id>
 *   reset-session   — POST /session/reset (empty or named) then refetch
 *   jump-to-belief  — fuzzy-pick a seeded belief and open its inspector
 *
 * Every mutate verb runs against the SCRATCH session (honesty constraint #2) and the page
 * refreshes its data after the run — the palette returns the verb intent; the page owns the
 * actual api call + state refresh, so the run log / KPI deltas / snapshot-diff stay in one place.
 *
 * Hand-rolled — no Radix/cmdk. Open state lives in SessionContext (⌘K toggles it globally).
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Database,
  GitBranch,
  RotateCcw,
  Search,
  Sparkles,
  Wrench,
  Inbox,
  Crosshair,
  type LucideIcon,
} from "lucide-react";

import type { Belief } from "@/lib/api";
import { Mono } from "@/components/primitives";
import { useSession } from "@/components/SessionContext";
import { SCENARIOS, nowIso } from "@/lib/session";

// ---------------------------------------------------------------------------
// the verb intents the page executes
// ---------------------------------------------------------------------------

/** A verb the page wires to its scratch-session api calls + post-run refresh. */
export type PaletteIntent =
  | { verb: "ingest"; text: string; now?: string }
  | { verb: "learn"; now?: string }
  | { verb: "maintain"; now?: string }
  | { verb: "retrieve"; query: string; now?: string }
  | { verb: "replay"; scenario: string }
  | { verb: "reset-session"; scenario?: string }
  | { verb: "inspect"; beliefId: string };

export interface CommandPaletteProps {
  /** The seeded beliefs (for jump-to-belief / inspect fuzzy-matching). Best-effort. */
  beliefs?: Belief[];
  /** Run a verb against the scratch session; the page does the api call + refresh. */
  onRun: (intent: PaletteIntent) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// verb catalog
// ---------------------------------------------------------------------------

type VerbId =
  | "ingest"
  | "learn"
  | "maintain"
  | "retrieve"
  | "replay"
  | "inspect"
  | "reset-session"
  | "jump-to-belief";

interface VerbSpec {
  id: VerbId;
  label: string;
  hint: string;
  icon: LucideIcon;
  /** kind of free-text argument this verb takes, if any */
  arg?: "text" | "query" | "scenario" | "belief";
  /** verbs that mutate accept a reproducible `now` */
  takesNow: boolean;
}

const VERBS: VerbSpec[] = [
  {
    id: "retrieve",
    label: "retrieve",
    hint: "query the scratch session — warms (promotes) the matched belief",
    icon: Search,
    arg: "query",
    takesNow: true,
  },
  {
    id: "learn",
    label: "learn",
    hint: "reconcile pending episodes into beliefs (form / reinforce / branch / supersede)",
    icon: Sparkles,
    takesNow: true,
  },
  {
    id: "maintain",
    label: "maintain",
    hint: "run retention — demote / merge / prune; reconstructs prune tombstones via diff",
    icon: Wrench,
    takesNow: true,
  },
  {
    id: "ingest",
    label: "ingest",
    hint: "add a quick note episode (source=notes kind=entry) to the feed",
    icon: Inbox,
    arg: "text",
    takesNow: true,
  },
  {
    id: "replay",
    label: "replay",
    hint: "re-seed the scratch db from a named scenario",
    icon: GitBranch,
    arg: "scenario",
    takesNow: false,
  },
  {
    id: "inspect",
    label: "inspect",
    hint: "open a belief's lifecycle inspector by id",
    icon: Crosshair,
    arg: "belief",
    takesNow: false,
  },
  {
    id: "jump-to-belief",
    label: "jump-to-belief",
    hint: "fuzzy-find a seeded belief and open its inspector",
    icon: ArrowRight,
    arg: "belief",
    takesNow: false,
  },
  {
    id: "reset-session",
    label: "reset-session",
    hint: "drop & re-seed the scratch db (optionally from a scenario) — never the live store",
    icon: RotateCcw,
    arg: "scenario",
    takesNow: false,
  },
];

// ---------------------------------------------------------------------------
// tiny fuzzy matcher — subsequence score, no dependency
// ---------------------------------------------------------------------------

/** Returns a match score (higher = better) or -1 if `query` isn't a subsequence of `text`. */
function fuzzyScore(query: string, text: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let score = 0;
  let streak = 0;
  let prevIdx = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      streak = prevIdx === ti - 1 ? streak + 1 : 1;
      score += streak * 2 + (ti === 0 ? 3 : 0); // reward contiguity + prefix
      prevIdx = ti;
      qi++;
    }
  }
  return qi === q.length ? score : -1;
}

// ---------------------------------------------------------------------------
// component
// ---------------------------------------------------------------------------

export function CommandPalette({ beliefs = [], onRun }: CommandPaletteProps) {
  const router = useRouter();
  const { paletteOpen, closePalette, now, setNow } = useSession();

  const [raw, setRaw] = React.useState("");
  const [active, setActive] = React.useState<VerbSpec | null>(null);
  const [arg, setArg] = React.useState("");
  const [nowEnabled, setNowEnabled] = React.useState(true);
  const [highlight, setHighlight] = React.useState(0);
  const [running, setRunning] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  // reset transient state whenever the palette opens.
  React.useEffect(() => {
    if (paletteOpen) {
      setRaw("");
      setActive(null);
      setArg("");
      setHighlight(0);
      setNowEnabled(true);
      // focus after the open transition
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [paletteOpen]);

  // verb list filtered by the fuzzy query (only when no verb is selected yet).
  const filtered = React.useMemo(() => {
    if (active) return [];
    const scored = VERBS.map((v) => ({
      v,
      score: Math.max(
        fuzzyScore(raw, v.label),
        fuzzyScore(raw, v.hint) - 5, // hint matches rank lower
      ),
    }));
    return scored
      .filter((s) => raw === "" || s.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((s) => s.v);
  }, [raw, active]);

  // belief suggestions when the active verb wants a belief argument.
  const beliefMatches = React.useMemo(() => {
    if (!active || active.arg !== "belief") return [];
    const scored = beliefs.map((b) => ({
      b,
      score: Math.max(fuzzyScore(arg, b.statement), fuzzyScore(arg, b.id)),
    }));
    return scored
      .filter((s) => arg === "" || s.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .map((s) => s.b);
  }, [active, arg, beliefs]);

  // scenario suggestions when the active verb wants a scenario argument.
  const scenarioMatches = React.useMemo(() => {
    if (!active || active.arg !== "scenario") return [];
    return SCENARIOS.filter(
      (s) => arg === "" || fuzzyScore(arg, s.name) >= 0 || fuzzyScore(arg, s.label) >= 0,
    );
  }, [active, arg]);

  if (!paletteOpen) return null;

  const isoNow = nowEnabled ? nowIso(now) : undefined;

  function selectVerb(v: VerbSpec) {
    setActive(v);
    setArg("");
    setHighlight(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  async function execute(intent: PaletteIntent) {
    setRunning(true);
    try {
      // navigation verbs are handled here; everything else delegates to the page.
      if (intent.verb === "inspect") {
        router.push(`/belief/${encodeURIComponent(intent.beliefId)}`);
        await onRun(intent); // let the page mirror selection if it wants
      } else {
        await onRun(intent);
      }
      closePalette();
    } finally {
      setRunning(false);
    }
  }

  function runActive() {
    if (!active) return;
    switch (active.id) {
      case "learn":
        void execute({ verb: "learn", now: isoNow });
        break;
      case "maintain":
        void execute({ verb: "maintain", now: isoNow });
        break;
      case "ingest":
        if (arg.trim()) void execute({ verb: "ingest", text: arg.trim(), now: isoNow });
        break;
      case "retrieve":
        if (arg.trim()) void execute({ verb: "retrieve", query: arg.trim(), now: isoNow });
        break;
      case "replay":
        if (arg.trim()) void execute({ verb: "replay", scenario: arg.trim() });
        break;
      case "reset-session":
        void execute({ verb: "reset-session", scenario: arg.trim() || undefined });
        break;
      case "inspect":
      case "jump-to-belief":
        // resolve the belief: exact id, else top fuzzy match
        {
          const exact = beliefs.find((b) => b.id === arg.trim());
          const target = exact ?? beliefMatches[0];
          if (target) void execute({ verb: "inspect", beliefId: target.id });
        }
        break;
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      if (active) {
        setActive(null);
        setArg("");
        setRaw("");
      } else {
        closePalette();
      }
      return;
    }
    if (e.key === "Backspace" && active && arg === "") {
      // back out of a selected verb
      e.preventDefault();
      setActive(null);
      return;
    }
    if (!active) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((h) => Math.min(filtered.length - 1, h + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => Math.max(0, h - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const v = filtered[highlight];
        if (v) selectVerb(v);
      }
      return;
    }
    // active verb: navigate suggestion lists or run
    const suggestions =
      active.arg === "belief"
        ? beliefMatches.length
        : active.arg === "scenario"
          ? scenarioMatches.length
          : 0;
    if (suggestions > 0 && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      setHighlight((h) =>
        e.key === "ArrowDown"
          ? Math.min(suggestions - 1, h + 1)
          : Math.max(0, h - 1),
      );
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      // if a suggestion is highlighted, adopt it first
      if (active.arg === "belief" && beliefMatches[highlight]) {
        void execute({ verb: "inspect", beliefId: beliefMatches[highlight].id });
        return;
      }
      if (active.arg === "scenario" && scenarioMatches[highlight]) {
        const name = scenarioMatches[highlight].name;
        if (active.id === "replay") void execute({ verb: "replay", scenario: name });
        else void execute({ verb: "reset-session", scenario: name });
        return;
      }
      runActive();
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center pt-[12vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div
        className="absolute inset-0 bg-black/55 backdrop-blur-[1px]"
        onClick={closePalette}
        aria-hidden
      />
      <div className="relative w-full max-w-xl overflow-hidden rounded-lg border border-border bg-surface-1 shadow-2xl">
        {/* search / arg input */}
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          {active ? (
            <span className="inline-flex items-center gap-1.5 rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5">
              <active.icon size={12} className="text-accent" />
              <Mono className="text-2xs text-accent">{active.label}</Mono>
            </span>
          ) : (
            <Search size={14} className="text-ink-dim" aria-hidden />
          )}
          <input
            ref={inputRef}
            value={active ? arg : raw}
            onChange={(e) => {
              if (active) setArg(e.target.value);
              else setRaw(e.target.value);
              setHighlight(0);
            }}
            onKeyDown={onKeyDown}
            placeholder={
              active
                ? active.arg === "query"
                  ? "search query, e.g. coffee"
                  : active.arg === "text"
                    ? "note text to ingest"
                    : active.arg === "scenario"
                      ? "scenario name (or ↵ for empty on reset)"
                      : active.arg === "belief"
                        ? "belief id or statement…"
                        : "press ↵ to run"
                : "run a verb — retrieve, learn, maintain, replay, inspect…"
            }
            className="mono flex-1 bg-transparent text-sm text-ink placeholder:text-ink-faint focus:outline-none"
            spellCheck={false}
            autoComplete="off"
          />
          {running ? <Mono faint className="text-2xs">running…</Mono> : null}
        </div>

        {/* body: verb list, or the active verb's arg suggestions + now toggle */}
        <div className="max-h-[46vh] overflow-y-auto py-1">
          {!active ? (
            filtered.length === 0 ? (
              <div className="px-3 py-6 text-center">
                <Mono faint className="text-2xs">
                  no verb matches “{raw}”
                </Mono>
              </div>
            ) : (
              filtered.map((v, i) => (
                <button
                  key={v.id}
                  type="button"
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => selectVerb(v)}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors"
                  style={{
                    backgroundColor: i === highlight ? "#4ED8C414" : "transparent",
                  }}
                >
                  <v.icon
                    size={14}
                    className={i === highlight ? "text-accent" : "text-ink-dim"}
                  />
                  <div className="min-w-0 flex-1">
                    <Mono
                      className="text-xs"
                      style={{ color: i === highlight ? "#4ED8C4" : undefined }}
                    >
                      {v.label}
                    </Mono>
                    <p className="truncate font-sans text-2xs text-ink-faint">{v.hint}</p>
                  </div>
                  {v.takesNow ? (
                    <Mono faint className="text-2xs">
                      now?
                    </Mono>
                  ) : null}
                </button>
              ))
            )
          ) : (
            <div className="px-1">
              {/* belief suggestions */}
              {active.arg === "belief" &&
                beliefMatches.map((b, i) => (
                  <button
                    key={b.id}
                    type="button"
                    onMouseEnter={() => setHighlight(i)}
                    onClick={() => void execute({ verb: "inspect", beliefId: b.id })}
                    className="flex w-full items-center gap-3 px-2 py-2 text-left transition-colors"
                    style={{
                      backgroundColor: i === highlight ? "#4ED8C414" : "transparent",
                    }}
                  >
                    <Crosshair
                      size={13}
                      className={i === highlight ? "text-accent" : "text-ink-dim"}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-sans text-xs text-ink">
                        {b.statement}
                      </span>
                      <Mono faint className="text-2xs">
                        {b.id} · {b.tier}
                      </Mono>
                    </span>
                  </button>
                ))}

              {/* scenario suggestions */}
              {active.arg === "scenario" &&
                scenarioMatches.map((s, i) => (
                  <button
                    key={s.name}
                    type="button"
                    onMouseEnter={() => setHighlight(i)}
                    onClick={() => {
                      if (active.id === "replay")
                        void execute({ verb: "replay", scenario: s.name });
                      else void execute({ verb: "reset-session", scenario: s.name });
                    }}
                    className="flex w-full items-center gap-3 px-2 py-2 text-left transition-colors"
                    style={{
                      backgroundColor: i === highlight ? "#4ED8C414" : "transparent",
                    }}
                  >
                    <GitBranch
                      size={13}
                      className={i === highlight ? "text-accent" : "text-ink-dim"}
                    />
                    <span className="min-w-0 flex-1">
                      <Mono
                        className="block text-xs"
                        style={{ color: i === highlight ? "#4ED8C4" : undefined }}
                      >
                        {s.name}
                      </Mono>
                      <span className="block truncate font-sans text-2xs text-ink-faint">
                        {s.blurb}
                      </span>
                    </span>
                  </button>
                ))}

              {/* free-text verbs (ingest/retrieve) get a run hint */}
              {(active.arg === "text" || active.arg === "query") && (
                <div className="px-3 py-2">
                  <Mono faint className="text-2xs">
                    {active.id === "retrieve"
                      ? "↵ retrieves — the matched belief warms (dormant → active)"
                      : "↵ ingests a note episode; run learn next to reconcile it"}
                  </Mono>
                </div>
              )}

              {/* verbs with no arg (learn/maintain) */}
              {!active.arg && (
                <div className="px-3 py-2">
                  <Mono faint className="text-2xs">
                    ↵ runs {active.label} against the scratch session
                  </Mono>
                </div>
              )}
            </div>
          )}
        </div>

        {/* footer: now control (reproducibility) + key hints */}
        <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-2">
          <div className="flex items-center gap-2">
            {active?.takesNow ? (
              <>
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={nowEnabled}
                    onChange={(e) => setNowEnabled(e.target.checked)}
                    className="h-3 w-3 accent-[#4ED8C4]"
                  />
                  <Mono dim className="text-2xs">
                    now
                  </Mono>
                </label>
                <Mono faint className="text-2xs">
                  {nowEnabled ? (isoNow ?? "wall-clock") : "server wall-clock"}
                </Mono>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setNow(new Date())}
                className="inline-flex items-center gap-1 text-ink-faint hover:text-ink-dim"
                title="reset now-cursor to wall clock"
              >
                <Database size={11} aria-hidden />
                <Mono className="text-2xs">scratch session</Mono>
              </button>
            )}
          </div>
          <div className="flex items-center gap-3">
            <Mono faint className="text-2xs">↑↓ move</Mono>
            <Mono faint className="text-2xs">↵ run</Mono>
            <Mono faint className="text-2xs">esc {active ? "back" : "close"}</Mono>
          </div>
        </div>
      </div>
    </div>
  );
}
