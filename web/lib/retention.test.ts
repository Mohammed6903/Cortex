import { describe, it, expect } from "vitest";
import {
  estimateRetention,
  RETENTION_THRESHOLDS,
  RETENTION_WEIGHTS,
  RECENCY_HALFLIFE_DAYS,
} from "./retention";
import type { Belief } from "./api";

const MS_PER_DAY = 86_400_000;

function belief(over: Partial<Belief> = {}): Belief {
  return {
    id: "bel_test",
    type: "preference",
    statement: "test",
    confidence: 0.8,
    salience: 0.6,
    tier: "active",
    validity_start: "2026-01-01T00:00:00+00:00",
    validity_end: null,
    reinforcement_count: 1,
    last_accessed_at: null,
    superseded_by: null,
    created_at: "2026-06-10T00:00:00+00:00",
    updated_at: "2026-06-10T00:00:00+00:00",
    ...over,
  };
}

describe("estimateRetention — port fidelity", () => {
  it("matches a hand-computed score (sal .6, reinf 1, 14d old)", () => {
    // reference = created_at; 14 days before now.
    const created = new Date("2026-06-10T00:00:00+00:00");
    const now = new Date(created.getTime() + 14 * MS_PER_DAY);
    const b = belief({ created_at: created.toISOString(), last_accessed_at: null });

    const r = estimateRetention(b, now);

    // recency = 0.5 ** (14/14) = 0.5
    expect(r.recency).toBeCloseTo(0.5, 10);
    // reinforcement = 1 - 1/(1+1) = 0.5
    expect(r.reinforcement).toBeCloseTo(0.5, 10);
    // score = 0.5*0.6 + 0.3*0.5 + 0.2*0.5 = 0.30 + 0.15 + 0.10 = 0.55
    expect(r.score).toBeCloseTo(0.55, 10);
  });

  it("prefers last_accessed_at over created_at as the recency reference", () => {
    const created = new Date("2026-01-01T00:00:00+00:00");
    const accessed = new Date("2026-06-10T00:00:00+00:00");
    const now = new Date(accessed.getTime() + 28 * MS_PER_DAY);
    const b = belief({
      created_at: created.toISOString(),
      last_accessed_at: accessed.toISOString(),
    });
    const r = estimateRetention(b, now);
    // 28 days => 2 halflives => recency 0.25 (measured from access, not creation)
    expect(r.recency).toBeCloseTo(0.25, 10);
  });

  it("clamps negative age to 0 (future reference => recency 1)", () => {
    const now = new Date("2026-06-10T00:00:00+00:00");
    const b = belief({ created_at: "2026-06-20T00:00:00+00:00", last_accessed_at: null });
    const r = estimateRetention(b, now);
    expect(r.daysSinceReference).toBe(0);
    expect(r.recency).toBe(1);
  });
});

describe("documented thresholds 0.35 / 0.15", () => {
  it("exposes the exact cliff constants", () => {
    expect(RETENTION_THRESHOLDS.dormant_retention_max).toBe(0.35);
    expect(RETENTION_THRESHOLDS.archive_retention_max).toBe(0.15);
    expect(RETENTION_THRESHOLDS.prune_salience_max).toBe(0.2);
    expect(RETENTION_WEIGHTS.w_salience).toBe(0.5);
    expect(RETENTION_WEIGHTS.w_reinforcement).toBe(0.3);
    expect(RETENTION_WEIGHTS.w_recency).toBe(0.2);
    expect(RECENCY_HALFLIFE_DAYS).toBe(14);
  });

  it("demotes active -> dormant when score < 0.35", () => {
    // Low salience, no reinforcement, old: salience 0.1, reinf 0, recency tiny.
    const created = new Date("2026-01-01T00:00:00+00:00");
    const now = new Date(created.getTime() + 200 * MS_PER_DAY);
    const b = belief({
      salience: 0.1,
      reinforcement_count: 0,
      tier: "active",
      created_at: created.toISOString(),
      last_accessed_at: null,
    });
    const r = estimateRetention(b, now);
    expect(r.score).toBeLessThan(0.35);
    expect(r.nextTier).toBe("dormant");
    expect(r.willDemote).toBe(true);
  });

  it("demotes dormant -> archived when score < 0.15", () => {
    const created = new Date("2026-01-01T00:00:00+00:00");
    const now = new Date(created.getTime() + 365 * MS_PER_DAY);
    const b = belief({
      salience: 0.1,
      reinforcement_count: 0,
      tier: "dormant",
      created_at: created.toISOString(),
      last_accessed_at: null,
    });
    const r = estimateRetention(b, now);
    expect(r.score).toBeLessThan(0.15);
    expect(r.nextTier).toBe("archived");
  });

  it("does not demote a healthy, recently-accessed active belief", () => {
    const now = new Date("2026-06-10T00:00:00+00:00");
    const b = belief({
      salience: 0.8,
      reinforcement_count: 3,
      tier: "active",
      last_accessed_at: now.toISOString(),
    });
    const r = estimateRetention(b, now);
    expect(r.score).toBeGreaterThan(0.35);
    expect(r.willDemote).toBe(false);
    expect(r.nextTier).toBe("active");
  });

  it("flags prune eligibility only for archived + low-salience + never-accessed", () => {
    const now = new Date("2026-06-10T00:00:00+00:00");
    const eligible = belief({
      tier: "archived",
      salience: 0.15,
      last_accessed_at: null,
    });
    expect(estimateRetention(eligible, now).pruneEligible).toBe(true);

    const accessed = belief({
      tier: "archived",
      salience: 0.15,
      last_accessed_at: now.toISOString(),
    });
    expect(estimateRetention(accessed, now).pruneEligible).toBe(false);

    const salient = belief({
      tier: "archived",
      salience: 0.5,
      last_accessed_at: null,
    });
    expect(estimateRetention(salient, now).pruneEligible).toBe(false);
  });

  it("computes a sane daysToNextDemotion for a coolable active belief", () => {
    // salience 0.2, reinf 0: score = 0.5*0.2 + 0.2*recency = 0.1 + 0.2*recency.
    // crosses 0.35 when 0.2*recency = 0.25 => recency 1.25 (>1) => already below => 0d.
    // Use salience 0.5 instead: 0.25 + 0.2*recency; crosses 0.35 when recency=0.5 => 14d.
    const now = new Date("2026-06-10T00:00:00+00:00");
    const b = belief({
      salience: 0.5,
      reinforcement_count: 0,
      tier: "active",
      created_at: now.toISOString(),
      last_accessed_at: now.toISOString(),
    });
    const r = estimateRetention(b, now);
    expect(r.daysToNextDemotion).not.toBeNull();
    expect(r.daysToNextDemotion!).toBeCloseTo(14, 4);
  });
});
