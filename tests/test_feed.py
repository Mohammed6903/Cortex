import json

from cortex.ingestion import feed
from cortex.store import episodes
from cortex.store.db import connect, init_schema


def _conn():
    c = connect(":memory:")
    init_schema(c)
    return c


EVENTS = [
    {
        "source": "calendar",
        "kind": "event_created",
        "payload": {"title": "1:1 with Prasana"},
        "occurred_at": "2026-06-23T09:00:00+00:00",
    },
    {
        "source": "editor",
        "kind": "file_opened",
        "payload": {"path": "main.py", "lang": "python"},
        "occurred_at": "2026-06-23T09:05:00+00:00",
    },
]


def test_replay_appends_each_event_as_an_episode():
    c = _conn()
    eps = feed.replay(c, EVENTS)
    assert len(eps) == 2
    assert episodes.count(c) == 2


def test_replay_is_idempotent():
    c = _conn()
    feed.replay(c, EVENTS)
    feed.replay(c, EVENTS)
    assert episodes.count(c) == 2


def test_replay_is_deterministic_across_runs():
    c1, c2 = _conn(), _conn()
    ids1 = [e.id for e in feed.replay(c1, EVENTS)]
    ids2 = [e.id for e in feed.replay(c2, EVENTS)]
    assert ids1 == ids2


def test_load_events_reads_a_scenario_file(tmp_path):
    p = tmp_path / "scenario.json"
    p.write_text(json.dumps({"name": "demo", "events": EVENTS}))
    loaded = feed.load_events(str(p))
    assert len(loaded) == 2
    assert loaded[0]["source"] == "calendar"
