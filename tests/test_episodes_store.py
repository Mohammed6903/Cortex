from datetime import datetime, timezone

from cortex.models import Episode
from cortex.store import episodes
from cortex.store.db import connect, init_schema


def _dt(s: str) -> datetime:
    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)


def _conn():
    c = connect(":memory:")
    init_schema(c)
    return c


def _ep(id_: str, occurred: str, **payload) -> Episode:
    return Episode(
        id=id_,
        source="browser",
        kind="visit",
        payload=payload,
        occurred_at=_dt(occurred),
        ingested_at=_dt(occurred),
    )


def test_append_then_get_roundtrips():
    c = _conn()
    episodes.append(c, _ep("e1", "2026-06-23T09:00:00", url="github.com"))
    got = episodes.get(c, "e1")
    assert got is not None
    assert got.payload == {"url": "github.com"}
    assert got.occurred_at == _dt("2026-06-23T09:00:00")


def test_append_is_idempotent():
    c = _conn()
    assert episodes.append(c, _ep("e1", "2026-06-23T09:00:00")) is True
    assert episodes.append(c, _ep("e1", "2026-06-23T09:00:00")) is False
    assert episodes.count(c) == 1


def test_recent_returns_last_n_in_chronological_order():
    c = _conn()
    episodes.append(c, _ep("e1", "2026-06-23T09:00:00"))
    episodes.append(c, _ep("e2", "2026-06-23T10:00:00"))
    episodes.append(c, _ep("e3", "2026-06-23T11:00:00"))
    recent = episodes.recent(c, limit=2)
    assert [e.id for e in recent] == ["e2", "e3"]


def test_get_missing_returns_none():
    c = _conn()
    assert episodes.get(c, "nope") is None
