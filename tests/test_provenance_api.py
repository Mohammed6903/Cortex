"""Tests for GET /beliefs/{id}/provenance.

Uses dependency_overrides + MockLLM exactly like tests/test_api.py, so the provenance
route is exercised against an in-memory engine with known episodes.
"""

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


def test_provenance_returns_source_episodes():
    # Distillation cites the episode ids; reconcile then attaches them as provenance.
    llm = MockLLM(
        structured=[
            {
                "beliefs": [
                    {
                        "type": "preference",
                        "statement": "Prefers coffee",
                        "confidence": 0.8,
                        "salience": 0.6,
                        "source_episode_ids": ["__EP__"],
                    }
                ]
            }
        ]
    )
    client, engine = _client(llm)

    ingest = client.post(
        "/ingest",
        json={
            "events": [
                {
                    "source": "notes",
                    "kind": "entry",
                    "payload": {"text": "switched to coffee"},
                    "occurred_at": "2026-06-20T08:00:00+00:00",
                }
            ]
        },
    )
    assert ingest.status_code == 200

    # Resolve the real episode id and re-seed the distiller output to cite it.
    from cortex.store import episodes as episode_store

    episodes = episode_store.recent(engine.conn, 10)
    assert episodes
    real_ep = episodes[0]
    llm._structured = [
        {
            "beliefs": [
                {
                    "type": "preference",
                    "statement": "Prefers coffee",
                    "confidence": 0.8,
                    "salience": 0.6,
                    "source_episode_ids": [real_ep.id],
                }
            ]
        }
    ]

    learn = client.post("/learn", json={"now": "2026-06-20T09:00:00+00:00"}).json()
    bid = learn["results"][0]["belief_id"]

    r = client.get(f"/beliefs/{bid}/provenance")
    assert r.status_code == 200
    prov = r.json()
    assert len(prov) == 1
    assert prov[0]["id"] == real_ep.id
    assert prov[0]["source"] == "notes"
    assert prov[0]["payload"]["text"] == "switched to coffee"
    # Episode shape carries both occurred_at and ingested_at.
    assert "occurred_at" in prov[0] and "ingested_at" in prov[0]


def test_provenance_falls_back_to_window_when_uncited():
    # The distiller attaches the whole window as provenance when the model cites nothing
    # usable, so a freshly formed belief still has a traceable source episode.
    llm = MockLLM(
        structured=[
            {
                "beliefs": [
                    {
                        "type": "fact",
                        "statement": "Lives in Pune",
                        "confidence": 0.9,
                        "salience": 0.6,
                        "source_episode_ids": [],
                    }
                ]
            }
        ]
    )
    client, _ = _client(llm)
    client.post(
        "/ingest",
        json={
            "events": [
                {
                    "source": "calendar",
                    "kind": "created",
                    "payload": {},
                    "occurred_at": "2026-06-23T09:00:00+00:00",
                }
            ]
        },
    )
    learn = client.post("/learn", json={"now": "2026-06-23T09:00:00+00:00"}).json()
    bid = learn["results"][0]["belief_id"]

    r = client.get(f"/beliefs/{bid}/provenance")
    assert r.status_code == 200
    prov = r.json()
    assert len(prov) == 1
    assert prov[0]["source"] == "calendar"


def test_provenance_404_for_unknown_belief():
    client, _ = _client(MockLLM())
    assert client.get("/beliefs/ghost/provenance").status_code == 404
