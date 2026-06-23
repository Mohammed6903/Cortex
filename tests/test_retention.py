from datetime import datetime, timezone

from cortex.config import Config
from cortex.lifecycle.distiller import CandidateBelief
from cortex.lifecycle.retention import apply_retention, prune, retention_score
from cortex.models import BeliefEventType, BeliefType, Tier
from cortex.store import beliefs
from cortex.store.db import connect, init_schema


def _dt(s: str) -> datetime:
    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)


def _conn():
    c = connect(":memory:")
    init_schema(c)
    return c


def _seed(c, statement, *, salience, conf=0.6, created, btype=BeliefType.fact):
    return beliefs.form(
        c,
        CandidateBelief(type=btype, statement=statement, confidence=conf, salience=salience, source_episode_ids=[]),
        now=created,
        vector=[1.0, 0.0],
    )


NOW = _dt("2026-08-01T09:00:00")


def test_recent_reinforced_salient_belief_scores_high():
    c = _conn()
    b = _seed(c, "x", salience=0.7, created=_dt("2026-07-31T09:00:00"))
    beliefs.reinforce(c, b.id, confidence=0.7, salience=0.7, now=_dt("2026-07-31T09:00:00"), detail={})
    beliefs.reinforce(c, b.id, confidence=0.7, salience=0.7, now=_dt("2026-07-31T09:00:00"), detail={})
    score = retention_score(beliefs.get(c, b.id), NOW, Config())
    assert score > Config().dormant_retention_max


def test_stale_trivial_belief_scores_low():
    c = _conn()
    b = _seed(c, "x", salience=0.1, created=_dt("2026-06-01T09:00:00"))
    score = retention_score(beliefs.get(c, b.id), NOW, Config())
    assert score <= Config().archive_retention_max


def test_apply_retention_demotes_stale_active_to_dormant():
    c = _conn()
    b = _seed(c, "x", salience=0.3, created=_dt("2026-07-02T09:00:00"))  # ~30 days stale
    apply_retention(c, Config(), NOW)
    assert beliefs.get(c, b.id).tier is Tier.dormant
    assert BeliefEventType.demoted in [e.event_type for e in beliefs.events(c, b.id)]


def test_apply_retention_archives_stale_dormant():
    c = _conn()
    b = _seed(c, "x", salience=0.1, created=_dt("2026-06-01T09:00:00"))
    c.execute("UPDATE beliefs SET tier='dormant' WHERE id=?", (b.id,))
    c.commit()
    apply_retention(c, Config(), NOW)
    assert beliefs.get(c, b.id).tier is Tier.archived


def test_high_salience_belief_survives_even_when_stale():
    c = _conn()
    b = _seed(c, "allergic to peanuts", salience=0.95, created=_dt("2026-06-01T09:00:00"))
    apply_retention(c, Config(), NOW)
    assert beliefs.get(c, b.id).tier is Tier.active


def test_prune_removes_archived_low_salience_unused():
    c = _conn()
    b = _seed(c, "trivia", salience=0.1, created=_dt("2026-06-01T09:00:00"))
    c.execute("UPDATE beliefs SET tier='archived' WHERE id=?", (b.id,))
    c.commit()
    pruned = prune(c, Config(), NOW)
    assert b.id in pruned
    assert beliefs.get(c, b.id) is None


def test_prune_spares_archived_but_salient_or_accessed():
    c = _conn()
    salient = _seed(c, "important", salience=0.5, created=_dt("2026-06-01T09:00:00"))
    accessed = _seed(c, "used", salience=0.1, created=_dt("2026-06-01T09:00:00"))
    c.execute("UPDATE beliefs SET tier='archived' WHERE id IN (?,?)", (salient.id, accessed.id))
    beliefs.touch(c, accessed.id, NOW)  # accessed => spared
    c.commit()
    pruned = prune(c, Config(), NOW)
    assert salient.id not in pruned
    assert accessed.id not in pruned


def test_touch_keeps_belief_hot_and_promotes_dormant():
    c = _conn()
    b = _seed(c, "x", salience=0.3, created=_dt("2026-07-02T09:00:00"))
    c.execute("UPDATE beliefs SET tier='dormant' WHERE id=?", (b.id,))
    c.commit()
    beliefs.touch(c, b.id, NOW)  # retrieval feedback
    promoted = beliefs.get(c, b.id)
    assert promoted.tier is Tier.active
    assert promoted.last_accessed_at == NOW
    # And now retention leaves it alone.
    apply_retention(c, Config(), NOW)
    assert beliefs.get(c, b.id).tier is Tier.active
