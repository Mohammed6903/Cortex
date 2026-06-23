from datetime import timezone

from fastapi.testclient import TestClient

from cortex.api import app, get_engine
from cortex.config import Config
from cortex.engine import Cortex
from cortex.llm.mock import MockLLM
from cortex.store.db import connect, init_schema


def _client(llm):
    conn = connect(":memory:")
    init_schema(conn)
    engine = Cortex(conn, llm, Config())
    app.dependency_overrides[get_engine] = lambda: engine
    return TestClient(app), engine


def teardown_function():
    app.dependency_overrides.clear()


def test_ingest_and_learn_then_list_beliefs():
    llm = MockLLM(
        structured=[{"beliefs": [{"type": "preference", "statement": "Prefers Python", "confidence": 0.8, "salience": 0.7, "source_episode_ids": []}]}]
    )
    client, _ = _client(llm)

    r = client.post("/ingest", json={"events": [
        {"source": "editor", "kind": "open", "payload": {"lang": "python"}, "occurred_at": "2026-06-23T09:00:00+00:00"}
    ]})
    assert r.status_code == 200
    assert r.json()["ingested"] == 1

    r = client.post("/learn", json={"now": "2026-06-23T09:00:00+00:00"})
    assert r.status_code == 200
    assert r.json()["results"][0]["action"] == "formed"

    r = client.get("/beliefs")
    assert r.status_code == 200
    assert any(b["statement"] == "Prefers Python" for b in r.json())


def test_belief_timeline_endpoint_returns_lifecycle_events():
    llm = MockLLM(
        structured=[{"beliefs": [{"type": "fact", "statement": "Lives in Pune", "confidence": 0.9, "salience": 0.6, "source_episode_ids": []}]}]
    )
    client, _ = _client(llm)
    client.post("/ingest", json={"events": [
        {"source": "calendar", "kind": "created", "payload": {}, "occurred_at": "2026-06-23T09:00:00+00:00"}
    ]})
    learn = client.post("/learn", json={"now": "2026-06-23T09:00:00+00:00"}).json()
    bid = learn["results"][0]["belief_id"]

    r = client.get(f"/beliefs/{bid}/timeline")
    assert r.status_code == 200
    events = r.json()
    assert events[0]["event_type"] == "formed"


def test_timeline_404_for_unknown_belief():
    client, _ = _client(MockLLM())
    assert client.get("/beliefs/ghost/timeline").status_code == 404
