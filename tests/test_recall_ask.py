"""Critical Recall context assembly + the ask/decide layer."""

from datetime import datetime, timezone

from cortex.ask import answer, route_mode
from cortex.config import Config
from cortex.engine import Cortex
from cortex.lifecycle.distiller import CandidateBelief
from cortex.llm.mock import MockLLM
from cortex.models import BeliefType
from cortex.recall import build_recall_context
from cortex.store import beliefs, profile
from cortex.store.db import connect, init_schema


def _dt(s: str) -> datetime:
    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)


NOW = _dt("2026-07-01T09:00:00")


def _engine(structured=None):
    conn = connect(":memory:")
    init_schema(conn)
    return Cortex(conn, MockLLM(structured=structured or []), Config(llm_provider="mock"))


def _seed(engine, type_, statement, *, confidence=0.7, salience=0.6):
    vec = engine.llm.embed([statement])[0]
    return beliefs.form(
        engine.conn,
        CandidateBelief(type=type_, statement=statement, confidence=confidence, salience=salience, source_episode_ids=[]),
        now=NOW,
        vector=vec,
    )


def _seed_world(engine):
    _seed(engine, BeliefType.fact, "Allergic to peanuts", salience=0.95)  # core constraint
    _seed(engine, BeliefType.goal, "Get fit and run a half marathon", salience=0.7)
    _seed(engine, BeliefType.preference, "Prefers spending on experiences over things", salience=0.6)
    _seed(engine, BeliefType.relationship, "Priya is my workout partner", salience=0.5)
    _seed(engine, BeliefType.transient_state, "Feeling low energy this week", salience=0.3)
    profile.set_authored(engine.conn, authored_voice="terse, dry, first-person", values_card="health; frugal-but-not-cheap", now=NOW)


# ---- Critical Recall ----

def test_recall_always_includes_goals_and_core_and_persona():
    engine = _engine()
    _seed_world(engine)
    ctx = build_recall_context(engine, "should I buy an annual gym membership?", NOW, engine.config)
    assert any(b.type is BeliefType.goal for b in ctx.goals)
    assert any("peanut" in b.statement.lower() for b in ctx.core)  # high-salience fact = core
    assert ctx.persona.authored_voice == "terse, dry, first-person"


def test_recall_dedupes_across_channels():
    engine = _engine()
    _seed_world(engine)
    ctx = build_recall_context(engine, "fitness spending decision", NOW, engine.config)
    ids = [b.id for b in ctx.all_beliefs()]
    assert len(ids) == len(set(ids))


def test_recall_respects_budget():
    engine = _engine()
    for i in range(40):
        _seed(engine, BeliefType.preference, f"random preference number {i}", salience=0.5)
    ctx = build_recall_context(engine, "anything", NOW, engine.config, budget=10)
    assert len(ctx.all_beliefs()) <= 10


# ---- mode routing ----

def test_route_mode_detects_draft_vs_decide():
    assert route_mode("draft a reply to my boss about the deadline") == "draft"
    assert route_mode("write a message to Priya canceling tonight") == "draft"
    assert route_mode("should I take the new job offer?") == "decide"
    assert route_mode("what's the smartest way to spend this weekend?") == "decide"


# ---- ask: decide ----

def test_ask_decide_returns_recommendation_and_filters_citations():
    engine = _engine()
    world_ids = [b.id for b in [
        _seed(engine, BeliefType.goal, "Get fit and run a half marathon", salience=0.7),
        _seed(engine, BeliefType.preference, "Prefers experiences over things", salience=0.6),
    ]]
    # scripted decide answer cites one real id + one bogus id (must be filtered out)
    engine.llm = MockLLM(structured=[{
        "recommendation": "Buy the membership — it serves the half-marathon goal.",
        "options": [{"action": "Buy annual", "rationale": "cheaper long-term", "fit": "high", "tradeoffs": "upfront cost"}],
        "confidence": 0.72,
        "conflicts": [],
        "cited_belief_ids": [world_ids[0], "bel_bogus"],
    }])
    res = answer(engine, "should I buy an annual gym membership?", mode="decide", now=NOW)
    assert res["mode"] == "decide"
    assert "membership" in res["recommendation"].lower()
    assert world_ids[0] in res["cited_belief_ids"]
    assert "bel_bogus" not in res["cited_belief_ids"]  # filtered to known beliefs


def test_ask_decide_touches_cited_beliefs():
    engine = _engine()
    g = _seed(engine, BeliefType.goal, "Ship Cortex v2", salience=0.8)
    engine.llm = MockLLM(structured=[{
        "recommendation": "Focus on v2.", "options": [], "confidence": 0.6,
        "conflicts": [], "cited_belief_ids": [g.id],
    }])
    answer(engine, "what should I work on?", mode="decide", now=NOW)
    assert beliefs.get(engine.conn, g.id).last_accessed_at is not None  # retention feedback


# ---- ask: draft ----

def test_ask_draft_returns_text_in_voice():
    engine = _engine()
    profile.set_authored(engine.conn, authored_voice="warm but brief", values_card="", now=NOW)
    p = _seed(engine, BeliefType.preference, "Prefers async over meetings", salience=0.6)
    engine.llm = MockLLM(structured=[{
        "draft": "Hey — let's keep this async; a doc works better for me than a call.",
        "tone_notes": "warm, brief",
        "cited_belief_ids": [p.id],
    }])
    res = answer(engine, "draft a reply declining a meeting", mode="draft", now=NOW)
    assert res["mode"] == "draft"
    assert "async" in res["draft"].lower()
    assert p.id in res["cited_belief_ids"]
