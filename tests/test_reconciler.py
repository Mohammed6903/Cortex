from datetime import datetime, timezone

from cortex.config import Config
from cortex.lifecycle.distiller import CandidateBelief
from cortex.lifecycle.reconciler import Action, reconcile
from cortex.llm.mock import MockLLM
from cortex.models import BeliefEventType, BeliefType, Tier
from cortex.store import beliefs
from cortex.store.db import connect, init_schema


def _dt(s: str) -> datetime:
    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)


def _conn():
    c = connect(":memory:")
    init_schema(c)
    return c


def _cand(statement, btype=BeliefType.preference, conf=0.7, sal=0.6, eps=None):
    return CandidateBelief(
        type=btype,
        statement=statement,
        confidence=conf,
        salience=sal,
        source_episode_ids=eps or [],
    )


def _event_types(conn, belief_id):
    return [e.event_type for e in beliefs.events(conn, belief_id)]


def test_forms_new_belief_when_nothing_related_exists():
    c = _conn()
    llm = MockLLM()  # no structured needed: no matches => no classification
    res = reconcile(c, llm, _cand("Prefers Python"), now=_dt("2026-06-23T09:00:00"), config=Config())
    assert res.action is Action.formed
    b = beliefs.get(c, res.belief_id)
    assert b.tier is Tier.active
    assert _event_types(c, b.id) == [BeliefEventType.formed]


def test_reinforces_when_classifier_says_reinforces():
    c = _conn()
    # Seed.
    first = reconcile(c, MockLLM(), _cand("Prefers Python", conf=0.7), now=_dt("2026-06-23T09:00:00"), config=Config())
    # Corroborating evidence, identical statement => cosine 1.0 => related.
    llm = MockLLM(structured=[{"relation": "reinforces", "reason": "same preference"}])
    res = reconcile(c, llm, _cand("Prefers Python", conf=0.7, eps=[]), now=_dt("2026-06-24T09:00:00"), config=Config())
    assert res.action is Action.reinforced
    assert res.belief_id == first.belief_id
    b = beliefs.get(c, first.belief_id)
    assert b.reinforcement_count == 1
    assert b.confidence > 0.7  # bumped
    assert BeliefEventType.reinforced in _event_types(c, b.id)
    # Still exactly one belief.
    assert len(beliefs.all_beliefs(c)) == 1


def test_contradiction_supersedes_a_fact():
    c = _conn()
    old = reconcile(c, MockLLM(), _cand("Lives in Mumbai", btype=BeliefType.fact), now=_dt("2026-06-23T09:00:00"), config=Config())
    llm = MockLLM(structured=[{"relation": "contradicts", "reason": "moved"}])
    res = reconcile(c, llm, _cand("Lives in Pune", btype=BeliefType.fact), now=_dt("2026-07-01T09:00:00"), config=Config())
    assert res.action is Action.superseded
    assert res.prior_id == old.belief_id
    old_b = beliefs.get(c, old.belief_id)
    new_b = beliefs.get(c, res.belief_id)
    assert old_b.tier is Tier.archived
    assert old_b.superseded_by == new_b.id
    assert old_b.validity_end == _dt("2026-07-01T09:00:00")
    assert new_b.tier is Tier.active
    assert BeliefEventType.contradicted in _event_types(c, old_b.id)
    assert BeliefEventType.superseded in _event_types(c, old_b.id)


def test_contradiction_branches_a_preference_into_a_timeline():
    c = _conn()
    old = reconcile(c, MockLLM(), _cand("Prefers tea", btype=BeliefType.preference), now=_dt("2026-06-23T09:00:00"), config=Config())
    llm = MockLLM(structured=[{"relation": "contradicts", "reason": "switched"}])
    res = reconcile(c, llm, _cand("Prefers coffee", btype=BeliefType.preference), now=_dt("2026-07-01T09:00:00"), config=Config())
    assert res.action is Action.branched
    old_b = beliefs.get(c, old.belief_id)
    new_b = beliefs.get(c, res.belief_id)
    # The old preference is kept as history (validity closed, demoted), not archived-as-wrong.
    assert old_b.validity_end == _dt("2026-07-01T09:00:00")
    assert old_b.tier is Tier.dormant
    assert old_b.superseded_by == new_b.id
    assert new_b.tier is Tier.active
    assert BeliefEventType.contradicted in _event_types(c, old_b.id)


def test_unrelated_topic_forms_a_separate_belief():
    c = _conn()
    reconcile(c, MockLLM(), _cand("Prefers Python"), now=_dt("2026-06-23T09:00:00"), config=Config())
    llm = MockLLM(structured=[{"relation": "unrelated", "reason": "different topic"}])
    res = reconcile(c, llm, _cand("Prefers tea"), now=_dt("2026-06-24T09:00:00"), config=Config())
    assert res.action is Action.formed
    assert len(beliefs.all_beliefs(c, tier=Tier.active)) == 2
