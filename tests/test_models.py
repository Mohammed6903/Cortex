from datetime import datetime, timezone

from cortex.models import (
    Belief,
    BeliefEvent,
    BeliefEventType,
    BeliefType,
    Episode,
    Tier,
)


def _dt(s: str) -> datetime:
    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)


def test_belief_types_cover_the_five_kinds():
    assert {t.value for t in BeliefType} == {
        "preference",
        "fact",
        "goal",
        "relationship",
        "transient_state",
    }


def test_tiers_are_active_dormant_archived():
    assert [t.value for t in Tier] == ["active", "dormant", "archived"]


def test_belief_event_types_cover_the_lifecycle():
    assert {e.value for e in BeliefEventType} == {
        "formed",
        "reinforced",
        "contradicted",
        "superseded",
        "merged",
        "demoted",
        "promoted",
        "pruned",
    }


def test_episode_normalizes_and_keeps_payload():
    ep = Episode(
        id="e1",
        source="calendar",
        kind="event_created",
        payload={"title": "1:1 with Prasana"},
        occurred_at=_dt("2026-06-23T09:00:00"),
        ingested_at=_dt("2026-06-23T09:00:01"),
    )
    assert ep.payload["title"] == "1:1 with Prasana"
    assert ep.source == "calendar"


def test_belief_has_sensible_lifecycle_defaults():
    b = Belief(
        id="b1",
        type=BeliefType.preference,
        statement="Prefers Python over Java",
        confidence=0.8,
        salience=0.7,
        validity_start=_dt("2026-06-23T09:00:00"),
    )
    # A freshly formed belief starts active, unreinforced, never superseded.
    assert b.tier is Tier.active
    assert b.reinforcement_count == 0
    assert b.superseded_by is None
    assert b.validity_end is None
    assert b.last_accessed_at is None


def test_belief_confidence_must_be_a_probability():
    import pytest
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        Belief(
            id="bad",
            type=BeliefType.fact,
            statement="impossible",
            confidence=1.5,
            salience=0.5,
            validity_start=_dt("2026-06-23T09:00:00"),
        )


def test_belief_event_records_a_transition_with_detail():
    ev = BeliefEvent(
        belief_id="b1",
        event_type=BeliefEventType.reinforced,
        detail={"from_confidence": 0.8, "to_confidence": 0.88},
        at=_dt("2026-06-24T10:00:00"),
    )
    assert ev.event_type is BeliefEventType.reinforced
    assert ev.detail["to_confidence"] == 0.88
