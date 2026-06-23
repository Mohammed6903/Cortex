from datetime import datetime, timezone

from cortex.lifecycle.distiller import CandidateBelief
from cortex.models import BeliefType, Tier
from cortex.store import beliefs, vectors
from cortex.store.db import connect, init_schema


def _dt(s: str) -> datetime:
    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)


def test_cosine_identical_is_one_orthogonal_is_zero():
    assert abs(vectors.cosine([1.0, 0.0], [1.0, 0.0]) - 1.0) < 1e-9
    assert abs(vectors.cosine([1.0, 0.0], [0.0, 1.0])) < 1e-9


def test_search_ranks_by_similarity_and_filters_by_type_and_tier():
    c = connect(":memory:")
    init_schema(c)
    # Two preference beliefs with distinct vectors.
    b_py = beliefs.form(
        c,
        CandidateBelief(type=BeliefType.preference, statement="python", confidence=0.8, salience=0.7, source_episode_ids=[]),
        now=_dt("2026-06-23T09:00:00"),
        vector=[1.0, 0.0],
    )
    b_java = beliefs.form(
        c,
        CandidateBelief(type=BeliefType.preference, statement="java", confidence=0.8, salience=0.7, source_episode_ids=[]),
        now=_dt("2026-06-23T09:01:00"),
        vector=[0.0, 1.0],
    )
    # A fact belief that must be excluded by the type filter.
    beliefs.form(
        c,
        CandidateBelief(type=BeliefType.fact, statement="other", confidence=0.8, salience=0.7, source_episode_ids=[]),
        now=_dt("2026-06-23T09:02:00"),
        vector=[1.0, 0.0],
    )

    hits = vectors.search(c, [1.0, 0.0], belief_type=BeliefType.preference, tier=Tier.active, min_score=0.1)
    assert [bid for bid, _ in hits] == [b_py.id]  # java is orthogonal (score 0), filtered by min_score
    assert hits[0][1] > 0.99


def test_search_excludes_archived():
    c = connect(":memory:")
    init_schema(c)
    b = beliefs.form(
        c,
        CandidateBelief(type=BeliefType.fact, statement="x", confidence=0.8, salience=0.7, source_episode_ids=[]),
        now=_dt("2026-06-23T09:00:00"),
        vector=[1.0, 0.0],
    )
    c.execute("UPDATE beliefs SET tier='archived' WHERE id=?", (b.id,))
    c.commit()
    hits = vectors.search(c, [1.0, 0.0], belief_type=BeliefType.fact, tier=Tier.active, min_score=0.1)
    assert hits == []
