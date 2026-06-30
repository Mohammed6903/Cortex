from datetime import datetime, timezone

from cortex.config import Config
from cortex.engine import Cortex
from cortex.llm.mock import MockLLM
from cortex.store import profile
from cortex.store.db import connect, init_schema
from cortex.voice import refresh_inferred_voice


def _dt(s: str) -> datetime:
    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)


def _engine(completions=None):
    c = connect(":memory:")
    init_schema(c)
    return Cortex(c, MockLLM(completions=completions or []), Config(llm_provider="mock"))


def test_refresh_summarizes_voice_from_journal_entries():
    engine = _engine(completions=["You write in short, direct, slightly dry sentences; you value momentum and honesty."])
    engine.ingest([
        {"source": "journal", "kind": "entry", "payload": {"text": "shipped the thing, moving on"}, "occurred_at": "2026-07-01T09:00:00+00:00"},
        {"source": "journal", "kind": "entry", "payload": {"text": "meetings kill my morning, keeping it async"}, "occurred_at": "2026-07-01T10:00:00+00:00"},
    ])
    p = refresh_inferred_voice(engine, now=_dt("2026-07-01T11:00:00"))
    assert "direct" in p.inferred_voice.lower()
    assert profile.get_profile(engine.conn).inferred_voice == p.inferred_voice


def test_refresh_noop_without_journal_entries():
    engine = _engine()
    p = refresh_inferred_voice(engine, now=_dt("2026-07-01T11:00:00"))
    assert p.inferred_voice == ""  # nothing to learn from; no LLM call needed
