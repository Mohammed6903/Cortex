from datetime import datetime, timezone

from cortex.store import profile
from cortex.store.db import connect, init_schema


def _dt(s: str) -> datetime:
    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)


def _conn():
    c = connect(":memory:")
    init_schema(c)
    return c


def test_get_on_empty_returns_blank_profile():
    p = profile.get_profile(_conn())
    assert p.authored_voice == ""
    assert p.inferred_voice == ""
    assert p.values_card == ""


def test_set_authored_then_get_roundtrips():
    c = _conn()
    profile.set_authored(c, authored_voice="terse, direct, dry humor", values_card="ship fast; honesty", now=_dt("2026-07-01T09:00:00"))
    p = profile.get_profile(c)
    assert p.authored_voice == "terse, direct, dry humor"
    assert p.values_card == "ship fast; honesty"


def test_set_inferred_does_not_clobber_authored():
    c = _conn()
    profile.set_authored(c, authored_voice="terse", values_card="honesty", now=_dt("2026-07-01T09:00:00"))
    profile.set_inferred(c, inferred_voice="writes in short imperative sentences", now=_dt("2026-07-02T09:00:00"))
    p = profile.get_profile(c)
    assert p.authored_voice == "terse"  # preserved
    assert p.inferred_voice == "writes in short imperative sentences"


def test_set_authored_is_upsert():
    c = _conn()
    profile.set_authored(c, authored_voice="v1", values_card="", now=_dt("2026-07-01T09:00:00"))
    profile.set_authored(c, authored_voice="v2", values_card="", now=_dt("2026-07-03T09:00:00"))
    assert profile.get_profile(c).authored_voice == "v2"
