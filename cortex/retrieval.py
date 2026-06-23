"""Retrieval over the current belief set.

Deliberately lean in this build: a hybrid rank that blends semantic similarity with a
salience boost, restricted to *current* beliefs (active tier, open validity window).
Retrieving a belief is not free of consequence — each hit is ``touch``ed, which feeds the
retention engine ("use it or lose it").
"""

from __future__ import annotations

from datetime import datetime

from .config import Config
from .llm.base import LLMClient
from .models import Belief, Tier
from .store import beliefs, vectors

_SEMANTIC_WEIGHT = 0.85
_SALIENCE_WEIGHT = 0.15


def retrieve(
    conn,
    llm: LLMClient,
    query: str,
    k: int,
    now: datetime,
    config: Config,
) -> list[Belief]:
    qv = llm.embed([query])[0]
    hits = vectors.search(conn, qv, belief_type=None, tier=Tier.active, min_score=0.0)

    scored: list[tuple[Belief, float]] = []
    for belief_id, sim in hits:
        belief = beliefs.get(conn, belief_id)
        if belief is None or belief.validity_end is not None:
            continue
        blended = _SEMANTIC_WEIGHT * sim + _SALIENCE_WEIGHT * belief.salience
        scored.append((belief, blended))

    scored.sort(key=lambda t: (t[1], t[0].created_at or now), reverse=True)
    top = [b for b, _ in scored[:k]]
    for belief in top:
        beliefs.touch(conn, belief.id, now)
    return top
