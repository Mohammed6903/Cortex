"""Regression: concurrent /session/reset must not crash.

The UI fires reset concurrently (React dev double-effect + re-mount on navigation). Before
the session lock, two resets interleaved on the same scratch db and the second died inside
beliefs.form with a duplicate-PK / locked-db error. This pins the fix.
"""

import time
from concurrent.futures import ThreadPoolExecutor

import cortex.session as session_mod
from cortex.session import Session, get_session


def test_concurrent_resets_all_succeed(tmp_path, monkeypatch):
    monkeypatch.setenv("CORTEX_SCRATCH_DB_PATH", str(tmp_path / "scratch.db"))
    session = Session()

    def do_reset() -> dict:
        return session.reset("02_contradiction_branch")

    with ThreadPoolExecutor(max_workers=8) as ex:
        results = [f.result() for f in [ex.submit(do_reset) for _ in range(24)]]

    # Every reset returns a clean, fully-seeded scratch (2 beliefs: coffee active, tea dormant).
    assert all(r["ok"] for r in results)
    assert all(r["beliefs"] == 2 for r in results)
    # And the session ends in a consistent state.
    assert len(session.engine().all_beliefs()) == 2


def test_cold_start_get_session_creates_exactly_one(tmp_path, monkeypatch):
    # The real bug: on a COLD process the UI fires reset concurrently, so two threads each
    # pass the `_SESSION is None` check and build their own Session — two locks, no
    # serialization — then collide seeding the same scratch db. Deterministically force the
    # window open with a slow __init__ and assert the singleton guard builds exactly one.
    monkeypatch.setenv("CORTEX_SCRATCH_DB_PATH", str(tmp_path / "cold.db"))
    monkeypatch.setattr(session_mod, "_SESSION", None, raising=False)

    constructions = []
    original_init = Session.__init__

    def slow_init(self, *args, **kwargs):
        constructions.append(1)
        time.sleep(0.05)  # widen the creation window so a racy guard would double-build
        original_init(self, *args, **kwargs)

    monkeypatch.setattr(Session, "__init__", slow_init)

    with ThreadPoolExecutor(max_workers=12) as ex:
        sessions = [f.result() for f in [ex.submit(get_session) for _ in range(12)]]

    assert len({id(s) for s in sessions}) == 1  # all callers share one instance
    assert sum(constructions) == 1  # constructed exactly once despite the burst


def test_lazy_first_use_is_seeded_once_under_contention(tmp_path, monkeypatch):
    monkeypatch.setenv("CORTEX_SCRATCH_DB_PATH", str(tmp_path / "scratch2.db"))
    session = Session()

    with ThreadPoolExecutor(max_workers=8) as ex:
        counts = [f.result() for f in [ex.submit(lambda: len(session.engine().all_beliefs())) for _ in range(16)]]

    # Default scenario seeds 2 beliefs; concurrent first-callers must not double-seed.
    assert all(c == 2 for c in counts)
