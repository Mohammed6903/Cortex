"""The persistent 'brain' store — real daily memory, isolated from the scratch demo."""

from datetime import datetime, timezone

from cortex.config import Config
from cortex.lifecycle.distiller import CandidateBelief
from cortex.models import BeliefType, Tier
from cortex.session import BrainSession
from cortex.store import beliefs


def _dt(s: str) -> datetime:
    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)


def _cfg(tmp_path) -> Config:
    return Config(brain_db_path=str(tmp_path / "brain.db"), llm_provider="mock")


def _form(engine, statement, *, salience=0.6, tier=None):
    b = beliefs.form(
        engine.conn,
        CandidateBelief(type=BeliefType.fact, statement=statement, confidence=0.7, salience=salience, source_episode_ids=[]),
        now=_dt("2026-07-01T09:00:00"),
        vector=[1.0, 0.0],
    )
    if tier is not None:
        engine.conn.execute("UPDATE beliefs SET tier=? WHERE id=?", (tier.value, b.id))
        engine.conn.commit()
    return b


def test_brain_uses_its_own_persistent_path_not_scratch(tmp_path):
    brain = BrainSession(_cfg(tmp_path))
    assert brain.db_path == str(tmp_path / "brain.db")
    assert "scratch" not in brain.db_path


def test_brain_persists_across_sessions(tmp_path):
    cfg = _cfg(tmp_path)
    b = _form(BrainSession(cfg).engine(), "Lives in Pune")
    # A brand-new BrainSession on the same path must still see the belief (real persistence).
    reopened = BrainSession(cfg).engine()
    assert reopened is not None
    got = beliefs.get(reopened.conn, b.id)
    assert got is not None and got.statement == "Lives in Pune"


def test_brain_is_isolated_from_scratch(tmp_path, monkeypatch):
    # Forming in the brain must not leak into the scratch session and vice versa.
    monkeypatch.setenv("CORTEX_SCRATCH_DB_PATH", str(tmp_path / "scratch.db"))
    brain = BrainSession(_cfg(tmp_path)).engine()
    _form(brain, "brain-only belief")
    from cortex.session import Session

    scratch = Session(Config(llm_provider="mock"))
    # scratch seeds the default scenario; it must not contain the brain-only belief
    scratch_engine = scratch.engine()
    assert all(b.statement != "brain-only belief" for b in scratch_engine.all_beliefs())


def test_brain_maintain_no_prune_keeps_archived_low_salience(tmp_path):
    engine = BrainSession(_cfg(tmp_path)).engine()
    b = _form(engine, "trivial archived note", salience=0.1, tier=Tier.archived)
    # Safe brain maintenance: consolidates/demotes but never deletes.
    report = engine.maintain(now=_dt("2027-01-01T00:00:00"), prune=False)
    assert report["pruned"] == []
    assert beliefs.get(engine.conn, b.id) is not None
    # Explicit prune WOULD remove it (proves the flag actually gates deletion).
    engine.maintain(now=_dt("2027-01-01T00:00:00"), prune=True)
    assert beliefs.get(engine.conn, b.id) is None
