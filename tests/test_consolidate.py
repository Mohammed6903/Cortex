from datetime import datetime, timezone

from cortex.config import Config
from cortex.lifecycle.distiller import CandidateBelief
from cortex.lifecycle.reconciler import consolidate
from cortex.models import BeliefEventType, BeliefType, Tier
from cortex.store import beliefs
from cortex.store.db import connect, init_schema


def _dt(s: str) -> datetime:
    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)


def _conn():
    c = connect(":memory:")
    init_schema(c)
    return c


def _form(c, statement, now, vector, eps):
    return beliefs.form(
        c,
        CandidateBelief(
            type=BeliefType.fact,
            statement=statement,
            confidence=0.6,
            salience=0.5,
            source_episode_ids=eps,
        ),
        now=now,
        vector=vector,
    )


def test_consolidate_merges_near_duplicates_into_the_older_belief():
    c = _conn()
    # Two near-identical beliefs (same vector) formed at different times.
    older = _form(c, "Works at Acme", _dt("2026-06-23T09:00:00"), [1.0, 0.0], eps=[])
    newer = _form(c, "Employed at Acme", _dt("2026-06-24T09:00:00"), [1.0, 0.0], eps=[])

    merged = consolidate(c, Config(), now=_dt("2026-06-25T09:00:00"))

    assert (newer.id, older.id) in merged
    kept = beliefs.get(c, older.id)
    gone = beliefs.get(c, newer.id)
    assert kept.tier is Tier.active
    assert gone.tier is Tier.archived
    assert gone.superseded_by == older.id
    assert BeliefEventType.merged in [e.event_type for e in beliefs.events(c, newer.id)]


def test_consolidate_unions_provenance_onto_the_survivor():
    c = _conn()
    # Episodes must exist for the FK.
    from cortex.models import Episode
    from cortex.store import episodes

    for i in ("e1", "e2"):
        episodes.append(
            c,
            Episode(id=i, source="s", kind="k", payload={}, occurred_at=_dt("2026-06-23T09:00:00"), ingested_at=_dt("2026-06-23T09:00:00")),
        )
    older = _form(c, "Works at Acme", _dt("2026-06-23T09:00:00"), [1.0, 0.0], eps=["e1"])
    _form(c, "Employed at Acme", _dt("2026-06-24T09:00:00"), [1.0, 0.0], eps=["e2"])

    consolidate(c, Config(), now=_dt("2026-06-25T09:00:00"))
    assert set(beliefs.provenance(c, older.id)) == {"e1", "e2"}


def test_consolidate_leaves_distinct_beliefs_alone():
    c = _conn()
    _form(c, "Works at Acme", _dt("2026-06-23T09:00:00"), [1.0, 0.0], eps=[])
    _form(c, "Lives in Pune", _dt("2026-06-24T09:00:00"), [0.0, 1.0], eps=[])
    merged = consolidate(c, Config(), now=_dt("2026-06-25T09:00:00"))
    assert merged == []
    assert len(beliefs.all_beliefs(c, tier=Tier.active)) == 2
