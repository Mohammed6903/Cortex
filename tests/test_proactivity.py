from datetime import datetime, timezone

from cortex.lifecycle.distiller import CandidateBelief
from cortex.models import BeliefType, Episode
from cortex.proactivity import evaluate
from cortex.store import beliefs
from cortex.store.db import connect, init_schema


def _dt(s: str) -> datetime:
    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)


def _conn():
    c = connect(":memory:")
    init_schema(c)
    return c


def _state(c, statement):
    return beliefs.form(
        c,
        CandidateBelief(type=BeliefType.transient_state, statement=statement, confidence=0.8, salience=0.5, source_episode_ids=[]),
        now=_dt("2026-06-23T09:00:00"),
        vector=[1.0, 0.0],
    )


def _episode(payload):
    return Episode(id="e9", source="browser", kind="visit", payload=payload, occurred_at=_dt("2026-06-23T14:00:00"), ingested_at=_dt("2026-06-23T14:00:00"))


def test_nudges_when_recent_activity_collides_with_a_known_distraction():
    c = _conn()
    b = _state(c, "Distracted by YouTube")
    nudges = evaluate(c, [_episode({"url": "youtube.com"})])
    assert len(nudges) == 1
    assert nudges[0].belief_id == b.id
    assert "youtube" in nudges[0].message.lower()


def test_no_nudge_without_overlap():
    c = _conn()
    _state(c, "Distracted by YouTube")
    assert evaluate(c, [_episode({"url": "github.com"})]) == []


def test_only_transient_states_trigger_nudges():
    c = _conn()
    beliefs.form(
        c,
        CandidateBelief(type=BeliefType.preference, statement="Likes YouTube", confidence=0.8, salience=0.5, source_episode_ids=[]),
        now=_dt("2026-06-23T09:00:00"),
        vector=[1.0, 0.0],
    )
    assert evaluate(c, [_episode({"url": "youtube.com"})]) == []
