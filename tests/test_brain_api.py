from fastapi.testclient import TestClient

from cortex.api import app, get_brain_engine
from cortex.config import Config
from cortex.engine import Cortex
from cortex.llm.mock import MockLLM
from cortex.store.db import connect, init_schema


def _brain_client(structured=None):
    conn = connect(":memory:")
    init_schema(conn)
    engine = Cortex(conn, MockLLM(structured=structured or []), Config(llm_provider="mock"))
    app.dependency_overrides[get_brain_engine] = lambda: engine
    return TestClient(app), engine


def teardown_function():
    app.dependency_overrides.clear()


def test_profile_put_then_get():
    client, _ = _brain_client()
    r = client.put("/brain/profile", json={"authored_voice": "terse, dry", "values_card": "ship fast"})
    assert r.status_code == 200
    assert r.json()["authored_voice"] == "terse, dry"

    g = client.get("/brain/profile")
    assert g.status_code == 200
    assert g.json()["values_card"] == "ship fast"


def test_brain_beliefs_empty_initially():
    client, _ = _brain_client()
    r = client.get("/brain/beliefs?all=true")
    assert r.status_code == 200
    assert r.json() == []


def test_brain_stats_reports_provider():
    client, _ = _brain_client()
    r = client.get("/brain/stats")
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 0
    assert "provider" in body


def test_journal_entry_distills_a_belief():
    # Scripted distillation: one journal turn -> one belief.
    client, _ = _brain_client(
        structured=[{"beliefs": [{"type": "preference", "statement": "Prefers deep work in the morning", "confidence": 0.8, "salience": 0.7, "source_episode_ids": []}]}]
    )
    r = client.post("/brain/journal", json={"text": "I focus best in the early morning before messages start", "now": "2026-07-01T08:00:00+00:00"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert any("morning" in (x["statement"] or "").lower() for x in body["learned"])
    assert body["learned"][0]["action"] == "formed"
    # and it's now in the brain
    beliefs = client.get("/brain/beliefs?all=true").json()
    assert any("morning" in b["statement"].lower() for b in beliefs)


def test_journal_rejects_empty():
    client, _ = _brain_client()
    assert client.post("/brain/journal", json={"text": "   "}).status_code == 400


def test_journal_400_when_brain_is_mock_without_script():
    # No scripted responses => mock distiller raises => friendly 400, not 500.
    client, _ = _brain_client(structured=[])
    r = client.post("/brain/journal", json={"text": "some real thought"})
    assert r.status_code == 400
    assert "provider" in r.json()["detail"].lower()


def test_ask_decide_endpoint():
    client, engine = _brain_client()
    # seed a belief, then script a decide answer citing it
    from cortex.lifecycle.distiller import CandidateBelief
    from cortex.models import BeliefType
    from cortex.store import beliefs
    g = beliefs.form(
        engine.conn,
        CandidateBelief(type=BeliefType.goal, statement="Ship Cortex v2", confidence=0.8, salience=0.8, source_episode_ids=[]),
        now=__import__("datetime").datetime(2026, 7, 1, tzinfo=__import__("datetime").timezone.utc),
        vector=engine.llm.embed(["Ship Cortex v2"])[0],
    )
    engine.llm = MockLLM(structured=[{
        "recommendation": "Focus this week on v2.",
        "options": [{"action": "ship", "rationale": "it's the goal"}],
        "confidence": 0.7, "conflicts": [], "cited_belief_ids": [g.id],
    }])
    r = client.post("/brain/ask", json={"question": "what should I prioritize?", "mode": "decide"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["mode"] == "decide"
    assert g.id in body["cited_belief_ids"]
