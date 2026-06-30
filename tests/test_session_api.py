"""Tests for the scratch-session honesty routes: /session/reset, /stats, /config.

These exercise the real seed path (replay a scenario against MockLLM into a scratch db)
through the FastAPI surface, using an isolated scratch db per test so no real store is
ever touched and tests don't collide on the shared default path.
"""

import os

import pytest
from fastapi.testclient import TestClient

import cortex.session as session_mod
from cortex.api import app


@pytest.fixture
def client(tmp_path, monkeypatch):
    # Point the scratch session at an isolated temp db, and reset the module singleton
    # so each test gets a clean Session bound to that path.
    monkeypatch.setenv("CORTEX_SCRATCH_DB_PATH", str(tmp_path / "scratch.db"))
    monkeypatch.setattr(session_mod, "_SESSION", None)
    # The honesty routes resolve the engine via the real session (not an override), so
    # clear any leftover overrides from other test modules.
    app.dependency_overrides.clear()
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_default_session_seeds_non_empty(client):
    # First access to any engine-backed route lazily seeds the default scenario.
    r = client.get("/beliefs?all=true")
    assert r.status_code == 200
    assert len(r.json()) > 0, "default scratch session should not be empty"


def test_reset_with_scenario_seeds_branch(client):
    r = client.post("/session/reset", json={"scenario": "02_contradiction_branch"})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["beliefs"] >= 2  # "Prefers tea" (dormant) + "Prefers coffee" (active)
    assert body["db"].endswith("scratch.db")

    beliefs = client.get("/beliefs?all=true").json()
    statements = {b["statement"] for b in beliefs}
    assert "Prefers coffee" in statements
    assert "Prefers tea" in statements

    # The branch is a contradicted event with detail.kind == 'branch' — NOT a 'branched'
    # event type. Verify the real grammar on the old belief's timeline.
    tea = next(b for b in beliefs if b["statement"] == "Prefers tea")
    assert tea["tier"] == "dormant"
    tl = client.get(f"/beliefs/{tea['id']}/timeline").json()
    contradicted = [e for e in tl if e["event_type"] == "contradicted"]
    assert contradicted and contradicted[0]["detail"].get("kind") == "branch"
    assert not any(e["event_type"] == "branched" for e in tl)


def test_reset_empty_scratch(client):
    r = client.post("/session/reset", json={})
    assert r.status_code == 200
    assert r.json()["beliefs"] == 0
    assert client.get("/beliefs?all=true").json() == []


def test_reset_unknown_scenario_404(client):
    r = client.post("/session/reset", json={"scenario": "does_not_exist"})
    assert r.status_code == 404
    assert "available" in r.json()["detail"]


def test_reset_recreates_db_file(client, tmp_path):
    client.post("/session/reset", json={"scenario": "01_reinforcement"})
    assert os.path.exists(str(tmp_path / "scratch.db"))
    # Reset to empty drops the seeded beliefs.
    client.post("/session/reset", json={})
    assert client.get("/beliefs?all=true").json() == []


def test_stats_counts_by_tier(client):
    client.post("/session/reset", json={"scenario": "02_contradiction_branch"})
    r = client.get("/stats")
    assert r.status_code == 200
    s = r.json()
    assert s["held"] >= 1
    assert s["dormant"] >= 1
    assert s["total"] == s["held"] + s["dormant"] + s["archived"]
    assert s["scenario"] == "02_contradiction_branch"


def test_config_exposes_retention_formula(client):
    r = client.get("/config")
    assert r.status_code == 200
    c = r.json()
    assert c["weights"] == {"salience": 0.5, "reinforcement": 0.3, "recency": 0.2}
    assert c["recency_halflife_days"] == 14.0
    assert c["thresholds"]["dormant_retention_max"] == 0.35
    assert c["thresholds"]["archive_retention_max"] == 0.15
    assert c["prune"]["salience_max"] == 0.2
    assert c["prune"]["requires_tier"] == "archived"
    assert c["prune"]["requires_never_accessed"] is True


def test_existing_routes_still_work_against_scratch(client):
    # learn against an empty scratch returns no results but must not error or touch prod.
    client.post("/session/reset", json={})
    r = client.post("/learn", json={"now": "2026-06-23T09:00:00+00:00"})
    assert r.status_code == 200
    assert r.json()["results"] == []
