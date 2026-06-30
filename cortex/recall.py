"""Critical Recall — assemble a prioritized, bounded context window for a question.

The pitch called for retrieval that blends *similarity*, *importance*, and *relational*
memory rather than naive top-k. This builds exactly that, typed and budgeted:

  1. semantic     — beliefs most relevant to the question (engine.retrieve: embeddings + salience)
  2. core         — high-salience facts/preferences (hard constraints like allergies, strong likes),
                    included even if not semantically near, so decisions never ignore them
  3. goals        — all current goals (decision-relevant by default)
  4. relationships— people/orgs in play
  5. persona      — the owner's authored + inferred voice

Deduped by id (priority order: semantic > core > goals > relationships) and capped to a budget
so the prompt stays focused. Retrieval *touches* the semantic hits (retention feedback) — being
recalled to answer a question keeps a belief warm.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING

from .config import Config
from .models import Belief, BeliefType, Tier
from .store import beliefs as belief_store
from .store import profile as profile_store

if TYPE_CHECKING:  # avoid a runtime import cycle with engine
    from .engine import Cortex
    from .store.profile import Profile


@dataclass
class RecallContext:
    question: str
    semantic: list[Belief] = field(default_factory=list)
    core: list[Belief] = field(default_factory=list)
    goals: list[Belief] = field(default_factory=list)
    relationships: list[Belief] = field(default_factory=list)
    persona: "Profile | None" = None

    def all_beliefs(self) -> list[Belief]:
        """Deduped beliefs in priority order (semantic first)."""
        seen: set[str] = set()
        out: list[Belief] = []
        for group in (self.semantic, self.core, self.goals, self.relationships):
            for b in group:
                if b.id not in seen:
                    seen.add(b.id)
                    out.append(b)
        return out

    def belief_ids(self) -> set[str]:
        return {b.id for b in self.all_beliefs()}


def _active_open(conn, belief_type: BeliefType) -> list[Belief]:
    return [
        b
        for b in belief_store.all_beliefs(conn, tier=Tier.active)
        if b.type is belief_type and b.validity_end is None
    ]


def build_recall_context(
    engine: "Cortex",
    question: str,
    now: datetime,
    config: Config,
    *,
    k: int = 8,
    core_salience: float = 0.7,
    budget: int = 24,
) -> RecallContext:
    conn = engine.conn

    # 1. semantic — relevant + already-warm; this touches the hits.
    semantic = engine.retrieve(question, k=k, now=now)

    # 2. core — high-salience constraints/preferences, ALWAYS in scope (even if semantic
    #    already surfaced them; all_beliefs/render dedup so nothing is doubled). This is the
    #    guarantee that a decision never silently ignores a hard constraint.
    core = sorted(
        (
            b
            for t in (BeliefType.fact, BeliefType.preference)
            for b in _active_open(conn, t)
            if b.salience >= core_salience
        ),
        key=lambda b: b.salience,
        reverse=True,
    )

    # 3. goals — every active goal is decision-relevant.
    goals = _active_open(conn, BeliefType.goal)

    # 4. relationships — people/orgs (small set; include all active).
    relationships = _active_open(conn, BeliefType.relationship)

    ctx = RecallContext(
        question=question,
        semantic=semantic,
        core=core,
        goals=goals,
        relationships=relationships,
        persona=profile_store.get_profile(conn),
    )

    # Enforce the budget by trimming lowest-priority channels first (relationships, then
    # goals, then core); semantic is never trimmed below its own size.
    total = len(ctx.all_beliefs())
    if total > budget:
        for attr in ("relationships", "goals", "core"):
            if total <= budget:
                break
            group = getattr(ctx, attr)
            drop = min(len(group), total - budget)
            if drop:
                setattr(ctx, attr, group[: len(group) - drop])
                total -= drop
    return ctx
