from datetime import datetime, timezone

from cortex.config import Config
from cortex.lifecycle.distiller import CandidateBelief
from cortex.models import BeliefType, Tier
from cortex.retrieval import retrieve
from cortex.llm.mock import MockLLM
from cortex.store import beliefs
from cortex.store.db import connect, init_schema


def _dt(s: str) -> datetime:
    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)


def _conn():
    c = connect(":memory:")
    init_schema(c)
    return c


def _seed(c, statement, btype, now, vector):
    return beliefs.form(
        c,
        CandidateBelief(type=btype, statement=statement, confidence=0.7, salience=0.6, source_episode_ids=[]),
        now=now,
        vector=vector,
    )


def test_retrieve_ranks_by_relevance_to_the_query():
    c = _conn()
    llm = MockLLM()
    _seed(c, "Prefers Python for backend work", BeliefType.preference, _dt("2026-06-23T09:00:00"), llm.embed(["Prefers Python for backend work"])[0])
    _seed(c, "Allergic to peanuts", BeliefType.fact, _dt("2026-06-23T09:01:00"), llm.embed(["Allergic to peanuts"])[0])
    hits = retrieve(c, llm, "python backend language preference", k=1, now=_dt("2026-06-24T09:00:00"), config=Config())
    assert len(hits) == 1
    assert "Python" in hits[0].statement


def test_retrieve_touches_results_so_they_stay_hot():
    c = _conn()
    llm = MockLLM()
    b = _seed(c, "Prefers Python", BeliefType.preference, _dt("2026-06-23T09:00:00"), llm.embed(["Prefers Python"])[0])
    retrieve(c, llm, "python preference", k=1, now=_dt("2026-06-24T09:00:00"), config=Config())
    assert beliefs.get(c, b.id).last_accessed_at == _dt("2026-06-24T09:00:00")


def test_retrieve_excludes_non_active_beliefs():
    c = _conn()
    llm = MockLLM()
    b = _seed(c, "Prefers Python", BeliefType.preference, _dt("2026-06-23T09:00:00"), llm.embed(["Prefers Python"])[0])
    c.execute("UPDATE beliefs SET tier='archived' WHERE id=?", (b.id,))
    c.commit()
    hits = retrieve(c, llm, "python", k=5, now=_dt("2026-06-24T09:00:00"), config=Config())
    assert hits == []
