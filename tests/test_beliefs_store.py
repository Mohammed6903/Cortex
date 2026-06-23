from datetime import datetime, timezone

from cortex.lifecycle.distiller import CandidateBelief
from cortex.models import BeliefEventType, BeliefType, Episode, Tier
from cortex.store import beliefs, episodes
from cortex.store.db import connect, init_schema


def _dt(s: str) -> datetime:
    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)


def _conn_with_episodes():
    c = connect(":memory:")
    init_schema(c)
    for i, t in [("e1", "09:00:00"), ("e2", "09:05:00")]:
        episodes.append(
            c,
            Episode(
                id=i,
                source="editor",
                kind="open",
                payload={},
                occurred_at=_dt(f"2026-06-23T{t}"),
                ingested_at=_dt(f"2026-06-23T{t}"),
            ),
        )
    return c


def _candidate(**over):
    base = dict(
        type=BeliefType.preference,
        statement="Prefers Python",
        confidence=0.8,
        salience=0.7,
        source_episode_ids=["e1", "e2"],
    )
    base.update(over)
    return CandidateBelief(**base)


def test_form_persists_a_retrievable_active_belief():
    c = _conn_with_episodes()
    b = beliefs.form(c, _candidate(), now=_dt("2026-06-23T09:05:00"))
    got = beliefs.get(c, b.id)
    assert got is not None
    assert got.statement == "Prefers Python"
    assert got.tier is Tier.active
    assert got.reinforcement_count == 0
    assert got.validity_start == _dt("2026-06-23T09:05:00")


def test_form_stores_provenance():
    c = _conn_with_episodes()
    b = beliefs.form(c, _candidate(), now=_dt("2026-06-23T09:05:00"))
    assert set(beliefs.provenance(c, b.id)) == {"e1", "e2"}


def test_form_records_a_formed_event():
    c = _conn_with_episodes()
    b = beliefs.form(c, _candidate(), now=_dt("2026-06-23T09:05:00"))
    evs = beliefs.events(c, b.id)
    assert len(evs) == 1
    assert evs[0].event_type is BeliefEventType.formed


def test_form_stores_a_vector_when_provided():
    c = _conn_with_episodes()
    b = beliefs.form(c, _candidate(), now=_dt("2026-06-23T09:05:00"), vector=[0.1, 0.2])
    assert beliefs.get_vector(c, b.id) == [0.1, 0.2]


def test_id_is_deterministic_for_same_content_and_time():
    c1, c2 = _conn_with_episodes(), _conn_with_episodes()
    b1 = beliefs.form(c1, _candidate(), now=_dt("2026-06-23T09:05:00"))
    b2 = beliefs.form(c2, _candidate(), now=_dt("2026-06-23T09:05:00"))
    assert b1.id == b2.id


def test_all_beliefs_filters_by_tier():
    c = _conn_with_episodes()
    beliefs.form(c, _candidate(statement="a"), now=_dt("2026-06-23T09:05:00"))
    beliefs.form(c, _candidate(statement="b"), now=_dt("2026-06-23T09:06:00"))
    assert len(beliefs.all_beliefs(c, tier=Tier.active)) == 2
    assert len(beliefs.all_beliefs(c, tier=Tier.archived)) == 0
