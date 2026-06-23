from datetime import datetime, timezone

from cortex.ingestion.schema import ActivityEvent, normalize_event


def _dt(s: str) -> datetime:
    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)


def _event(**over):
    base = dict(
        source="browser",
        kind="visit",
        payload={"url": "youtube.com"},
        occurred_at=_dt("2026-06-23T09:00:00"),
    )
    base.update(over)
    return ActivityEvent(**base)


def test_normalize_preserves_fields():
    ep = normalize_event(_event(), ingested_at=_dt("2026-06-23T09:00:05"))
    assert ep.source == "browser"
    assert ep.kind == "visit"
    assert ep.payload == {"url": "youtube.com"}
    assert ep.occurred_at == _dt("2026-06-23T09:00:00")
    assert ep.ingested_at == _dt("2026-06-23T09:00:05")


def test_id_is_deterministic_for_identical_content():
    a = normalize_event(_event(), ingested_at=_dt("2026-06-23T09:00:05"))
    b = normalize_event(_event(), ingested_at=_dt("2026-06-23T23:00:00"))
    # Same content (even at a different ingest time) => same id => idempotent ingest.
    assert a.id == b.id


def test_id_differs_when_content_differs():
    a = normalize_event(_event(payload={"url": "youtube.com"}), ingested_at=_dt("2026-06-23T09:00:05"))
    b = normalize_event(_event(payload={"url": "github.com"}), ingested_at=_dt("2026-06-23T09:00:05"))
    assert a.id != b.id


def test_payload_key_order_does_not_change_id():
    a = normalize_event(
        _event(payload={"a": 1, "b": 2}), ingested_at=_dt("2026-06-23T09:00:05")
    )
    b = normalize_event(
        _event(payload={"b": 2, "a": 1}), ingested_at=_dt("2026-06-23T09:00:05")
    )
    assert a.id == b.id
