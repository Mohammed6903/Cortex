"""Forgetting by utility, not by age.

The source idea decayed memories on a timer (``importance / time``). Cortex instead scores
each belief by how *useful* it currently is — how salient, how often corroborated, and how
recently it was actually used — and lets low-utility beliefs drift down the tiers
``active → dormant → archived`` before a final prune. Crucially, *retrieval* refreshes
``last_accessed_at`` (see :func:`cortex.store.beliefs.touch`), so a belief that keeps
getting used never cools off. High-salience beliefs are structurally protected from pruning.
"""

from __future__ import annotations

from datetime import datetime

from ..config import Config
from ..models import Belief, BeliefEventType, Tier
from ..store import beliefs


def _days_between(later: datetime, earlier: datetime) -> float:
    return max(0.0, (later - earlier).total_seconds() / 86400.0)


def retention_score(belief: Belief, now: datetime, config: Config) -> float:
    """A utility score in [0, 1]. Higher means more worth keeping."""
    # Recency is measured from the last *access*, falling back to when the belief was formed.
    # Deliberately NOT updated_at: tier demotions touch updated_at, and using it would let a
    # belief refresh its own recency just by being demoted, stalling the slide to archived.
    reference = belief.last_accessed_at or belief.created_at or now
    days = _days_between(now, reference)
    recency = 0.5 ** (days / config.recency_halflife_days)

    # Diminishing returns on corroboration: 0 at count 0, approaching 1 as evidence stacks.
    reinforcement = 1.0 - 1.0 / (1.0 + belief.reinforcement_count)

    raw = (
        config.w_salience * belief.salience
        + config.w_reinforcement * reinforcement
        + config.w_recency * recency
    )
    total_weight = config.w_salience + config.w_reinforcement + config.w_recency
    return raw / total_weight if total_weight else 0.0


def apply_retention(conn, config: Config, now: datetime) -> list[tuple[str, str]]:
    """Demote low-utility beliefs one tier. Returns ``(belief_id, new_tier)`` changes."""
    changes: list[tuple[str, str]] = []
    for belief in beliefs.all_beliefs(conn):
        if belief.tier is Tier.archived:
            continue
        score = retention_score(belief, now, config)
        if belief.tier is Tier.active and score < config.dormant_retention_max:
            beliefs.set_tier(
                conn, belief.id, Tier.dormant, now, BeliefEventType.demoted,
                {"to": "dormant", "score": round(score, 4)},
            )
            changes.append((belief.id, "dormant"))
        elif belief.tier is Tier.dormant and score < config.archive_retention_max:
            beliefs.set_tier(
                conn, belief.id, Tier.archived, now, BeliefEventType.demoted,
                {"to": "archived", "score": round(score, 4)},
            )
            changes.append((belief.id, "archived"))
    return changes


def prune(conn, config: Config, now: datetime) -> list[str]:
    """Hard-delete beliefs that are archived AND low-salience AND never retrieved.

    A belief that was ever accessed (``last_accessed_at`` set) or remains salient is spared,
    so genuinely useful knowledge is never lost to forgetting.
    """
    pruned: list[str] = []
    for belief in beliefs.all_beliefs(conn, tier=Tier.archived):
        if belief.salience <= config.prune_salience_max and belief.last_accessed_at is None:
            beliefs.delete(conn, belief.id)
            pruned.append(belief.id)
    return pruned
