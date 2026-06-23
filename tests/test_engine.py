from datetime import datetime, timezone

from cortex.config import Config
from cortex.engine import Cortex
from cortex.llm.mock import MockLLM
from cortex.models import BeliefEventType, Tier
from cortex.store.db import connect, init_schema


def _dt(s: str) -> datetime:
    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)


def _engine(llm):
    c = connect(":memory:")
    init_schema(c)
    return Cortex(c, llm, Config())


def _belief_dict(statement, btype="preference"):
    return {
        "type": btype,
        "statement": statement,
        "confidence": 0.8,
        "salience": 0.7,
        "source_episode_ids": [],
    }


def test_ingest_then_learn_forms_a_belief():
    llm = MockLLM(structured=[{"beliefs": [_belief_dict("Prefers Python")]}])
    eng = _engine(llm)
    eng.ingest([
        {"source": "editor", "kind": "open", "payload": {"lang": "python"}, "occurred_at": "2026-06-23T09:00:00+00:00"},
    ])
    results = eng.learn(now=_dt("2026-06-23T09:00:00"))
    assert len(results) == 1
    active = eng.snapshot()
    assert [b.statement for b in active] == ["Prefers Python"]


def test_learning_a_contradiction_branches_the_timeline():
    llm = MockLLM(
        structured=[
            {"beliefs": [_belief_dict("Prefers Python")]},   # first distill
            {"beliefs": [_belief_dict("Prefers Java")]},      # second distill
            {"relation": "contradicts", "reason": "switched"},  # classify
        ]
    )
    eng = _engine(llm)
    eng.ingest([{"source": "editor", "kind": "open", "payload": {"lang": "python"}, "occurred_at": "2026-06-23T09:00:00+00:00"}])
    eng.learn(now=_dt("2026-06-23T09:00:00"))
    eng.ingest([{"source": "editor", "kind": "open", "payload": {"lang": "java"}, "occurred_at": "2026-09-01T09:00:00+00:00"}])
    eng.learn(now=_dt("2026-09-01T09:00:00"))

    statements = {b.statement for b in eng.snapshot()}
    assert statements == {"Prefers Java"}  # only the current belief is active

    # The superseded preference is retained as history with a closed validity window.
    all_beliefs = eng.all_beliefs()
    old = next(b for b in all_beliefs if b.statement == "Prefers Python")
    assert old.tier is Tier.dormant
    assert old.validity_end == _dt("2026-09-01T09:00:00")
    timeline_types = [e.event_type for e in eng.timeline(old.id)]
    assert BeliefEventType.formed in timeline_types
    assert BeliefEventType.contradicted in timeline_types


def test_maintain_runs_consolidation_retention_and_prune():
    llm = MockLLM(structured=[{"beliefs": [_belief_dict("Prefers Python")]}])
    eng = _engine(llm)
    eng.ingest([{"source": "editor", "kind": "open", "payload": {}, "occurred_at": "2026-06-23T09:00:00+00:00"}])
    eng.learn(now=_dt("2026-06-23T09:00:00"))
    report = eng.maintain(now=_dt("2026-06-24T09:00:00"))
    assert set(report.keys()) == {"merged", "demoted", "pruned"}
