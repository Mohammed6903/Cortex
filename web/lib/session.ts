/**
 * Scratch-session helpers for the Time-Travel + Command layer (Phase 4).
 *
 * Every learn/maintain/retrieve/replay the UI issues runs against the server-seeded
 * SCRATCH db — never the live store (honesty constraint #2). This module is the thin
 * vocabulary the scrubber + command palette share:
 *
 *   - the canonical list of replayable scenarios (mirrors evals/scenarios/*.json names),
 *   - a `now` <-> ISO bridge so a Date cursor can be threaded into /learn /maintain
 *     /retrieve `now` reproducibly,
 *   - `resetScratch()` — POST /session/reset wrapper that returns the typed response.
 *
 * It deliberately holds NO React state; NowContext (components/SessionContext.tsx) owns the
 * live `now` + scenario, and the Mind Monitor page owns the data refresh after every verb.
 */

import { api, type SessionResetResponse } from "./api";

/** The scenario seeded on first load — a branch/supersede story so the API is never empty. */
export const DEFAULT_SCENARIO = "02_contradiction_branch";

/**
 * The bare scenario names POST /session/reset accepts (no `.json`), mirroring
 * evals/scenarios. Omitting the scenario entirely seeds an EMPTY scratch.
 * Confirmed against the backend phase: unknown names 404.
 */
export interface ScenarioMeta {
  /** bare name passed to /session/reset, e.g. "02_contradiction_branch" */
  name: string;
  /** short human label for the palette / scrubber */
  label: string;
  /** one-line description of what the replay demonstrates */
  blurb: string;
}

export const SCENARIOS: ScenarioMeta[] = [
  {
    name: "01_reinforcement",
    label: "reinforcement",
    blurb: "the same belief observed twice — confidence climbs, no new row",
  },
  {
    name: "02_contradiction_branch",
    label: "contradiction · branch",
    blurb: "a preference changes — old belief branches to dormant, kept as history",
  },
  {
    name: "03_fact_supersede",
    label: "fact · supersede",
    blurb: "a corrected fact supersedes the old (contradicted + superseded, one act)",
  },
  {
    name: "04_stale_prune",
    label: "stale · prune",
    blurb: "an unused low-salience belief decays past the cliffs and is pruned on maintain",
  },
  {
    name: "05_use_it_or_lose_it",
    label: "use it or lose it",
    blurb: "a warmed belief survives where its cold twin demotes — touch() made physical",
  },
];

const SCENARIO_NAMES = new Set(SCENARIOS.map((s) => s.name));

/** True if `name` is a known replayable scenario (so the palette can validate before POST). */
export function isKnownScenario(name: string): boolean {
  return SCENARIO_NAMES.has(name);
}

/** Look up a scenario's metadata, or undefined for an unknown / empty seed. */
export function scenarioMeta(name: string | null | undefined): ScenarioMeta | undefined {
  if (!name) return undefined;
  return SCENARIOS.find((s) => s.name === name);
}

/** The session-chip label, e.g. "scratch·02_contradiction_branch" or "scratch (empty)". */
export function sessionLabel(scenario: string | null | undefined): string {
  return scenario ? `scratch·${scenario}` : "scratch (empty)";
}

// ---- now <-> ISO bridge ----

/**
 * The `now` cursor as an ISO instant for the /learn /maintain /retrieve `now` field.
 * All three routes accept it and run against the scratch db (backend-confirmed). Returns
 * undefined for a null cursor so callers omit `now` and let the server use wall-clock.
 */
export function nowIso(now: Date | null | undefined): string | undefined {
  return now ? now.toISOString() : undefined;
}

/** Parse an ISO instant back to a Date, or null if absent / unparseable. */
export function isoToDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t);
}

// ---- reset wrapper ----

/**
 * Seed a fresh scratch db, optionally re-seeded from a named scenario. Thin pass-through
 * to POST /session/reset so the palette/scrubber don't import the raw route. Omit
 * `scenario` for an empty scratch.
 */
export function resetScratch(
  scenario?: string,
): Promise<SessionResetResponse> {
  return api.resetSession(scenario);
}
