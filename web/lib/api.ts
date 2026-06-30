/**
 * Typed fetch client over the REAL Cortex HTTP API.
 *
 * Base = NEXT_PUBLIC_API_BASE ?? http://localhost:8000.
 *
 * Honesty notes baked in:
 *  - There is NO `branched` BeliefEvent type. A branch is a `contradicted` event
 *    carrying detail.kind === "branch". A supersede emits BOTH `contradicted` and
 *    `superseded` for one act — collapse them in the UI, never here.
 *  - PRUNED has no event; reconstruct it by snapshot-diffing two GET /beliefs?all=true
 *    reads across a maintain (see fetchBeliefs).
 *  - All learn/maintain/retrieve/replay should run against the scratch SESSION the
 *    backend seeds via POST /session/reset — never the live store.
 */

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

// ---- enums (mirror cortex/models.py) ----

export type BeliefTypeName =
  | "preference"
  | "fact"
  | "goal"
  | "relationship"
  | "transient_state";

export type TierName = "active" | "dormant" | "archived";

/** The ONLY real event types. `branched` is a UI fiction — do not add it. */
export type BeliefEventTypeName =
  | "formed"
  | "reinforced"
  | "contradicted"
  | "superseded"
  | "merged"
  | "demoted"
  | "promoted"
  | "pruned";

/** The action verbs POST /learn returns. Note: this surface DOES emit `branched`
 *  as a learn-result action even though no `branched` *event* exists. */
export type LearnAction = "formed" | "reinforced" | "superseded" | "branched";

// ---- domain records (mirror cortex/models.py model_dump) ----

export interface Belief {
  id: string;
  type: BeliefTypeName;
  statement: string;
  confidence: number; // 0..1
  salience: number; // 0..1
  tier: TierName;
  validity_start: string; // ISO datetime
  validity_end: string | null;
  reinforcement_count: number;
  last_accessed_at: string | null;
  superseded_by: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface BeliefEvent {
  id: number | null;
  belief_id: string;
  event_type: BeliefEventTypeName;
  detail: Record<string, unknown>;
  at: string; // ISO datetime
}

export interface Episode {
  id: string;
  source: string;
  kind: string;
  payload: Record<string, unknown>;
  occurred_at: string; // ISO datetime
  ingested_at: string; // ISO datetime
}

// ---- request / response bodies ----

export interface IngestEvent {
  source: string;
  kind: string;
  payload: Record<string, unknown>;
  occurred_at: string;
}

export interface IngestResponse {
  ingested: number;
}

export interface LearnResult {
  action: LearnAction;
  belief_id: string;
  prior_id: string | null;
}

export interface LearnResponse {
  results: LearnResult[];
}

/** maintain returns tuples — keep them as tuples so callers know the shape. */
export interface MaintainResponse {
  merged: [string, string][]; // [loserId, survivorId]
  demoted: [string, string][]; // [beliefId, newTier]
  pruned: string[];
}

// ---- NEW routes (added in the Backend phase; typed ahead of time) ----

export interface SessionResetResponse {
  ok: boolean;
  beliefs: number;
  db: string;
}

/**
 * GET /stats — tier population counts for the KPI strip. Confirmed shape from
 * cortex/api.py: `held` == the engine's `active` tier; there is NO pruned count
 * (prune emits no event/row — the UI reconstructs tombstones via snapshot-diff).
 * `last_learn` / `last_maintain` are NOT server fields — the client derives those
 * from the POST /learn and /maintain responses it issued.
 */
export interface StatsResponse {
  held: number; // == active tier
  dormant: number;
  archived: number;
  total: number;
  scenario: string | null;
}

/**
 * GET /config — the retention weights / halflife / cliffs / prune rule, nested
 * exactly as cortex/api.py returns them. Surfaced so the client estimate never
 * silently drifts from the engine formula.
 */
export interface ConfigResponse {
  weights: {
    salience: number; // 0.5
    reinforcement: number; // 0.3
    recency: number; // 0.2
  };
  recency_halflife_days: number; // 14
  thresholds: {
    dormant_retention_max: number; // 0.35
    archive_retention_max: number; // 0.15
  };
  prune: {
    salience_max: number; // 0.2
    requires_tier: string; // "archived"
    requires_never_accessed: boolean; // true
  };
}

// ---- low-level fetch ----

export class ApiError extends Error {
  constructor(
    public status: number,
    public route: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(
  route: string,
  init?: RequestInit,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${route}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      cache: "no-store",
    });
  } catch (e) {
    throw new ApiError(0, route, `network error: ${(e as Error).message}`);
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      if (body && typeof body.detail === "string") detail = body.detail;
    } catch {
      /* non-json error body */
    }
    throw new ApiError(res.status, route, detail);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function post<T>(route: string, body?: unknown): Promise<T> {
  return request<T>(route, {
    method: "POST",
    body: JSON.stringify(body ?? {}),
  });
}

function get<T>(route: string): Promise<T> {
  return request<T>(route, { method: "GET" });
}

// ---- the API surface ----

export const api = {
  base: API_BASE,

  ingest: (events: IngestEvent[]) =>
    post<IngestResponse>("/ingest", { events }),

  learn: (now?: string) => post<LearnResponse>("/learn", now ? { now } : {}),

  maintain: (now?: string) =>
    post<MaintainResponse>("/maintain", now ? { now } : {}),

  /** GET /beliefs?all=<bool>. all=true returns full history incl. demoted/archived. */
  beliefs: (all = false) =>
    get<Belief[]>(`/beliefs?all=${all ? "true" : "false"}`),

  belief: (id: string) => get<Belief>(`/beliefs/${encodeURIComponent(id)}`),

  /** THE inspector source. */
  timeline: (id: string) =>
    get<BeliefEvent[]>(`/beliefs/${encodeURIComponent(id)}/timeline`),

  retrieve: (query: string, k = 5, now?: string) =>
    post<Belief[]>("/retrieve", now ? { query, k, now } : { query, k }),

  // --- NEW routes (Backend phase) ---

  /** Seed a fresh SCRATCH db. Subsequent calls operate on it — never the live store. */
  resetSession: (scenario?: string) =>
    post<SessionResetResponse>("/session/reset", scenario ? { scenario } : {}),

  provenance: (id: string) =>
    get<Episode[]>(`/beliefs/${encodeURIComponent(id)}/provenance`),

  stats: () => get<StatsResponse>("/stats"),

  config: () => get<ConfigResponse>("/config"),
};

export type Api = typeof api;
