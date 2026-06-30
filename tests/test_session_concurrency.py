"""Regression: concurrent /session/reset must not crash.

The UI fires reset concurrently (React dev double-effect + re-mount on navigation). Before
the session lock, two resets interleaved on the same scratch db and the second died inside
beliefs.form with a duplicate-PK / locked-db error. This pins the fix.
"""

from concurrent.futures import ThreadPoolExecutor

from cortex.session import Session


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


def test_lazy_first_use_is_seeded_once_under_contention(tmp_path, monkeypatch):
    monkeypatch.setenv("CORTEX_SCRATCH_DB_PATH", str(tmp_path / "scratch2.db"))
    session = Session()

    with ThreadPoolExecutor(max_workers=8) as ex:
        counts = [f.result() for f in [ex.submit(lambda: len(session.engine().all_beliefs())) for _ in range(16)]]

    # Default scenario seeds 2 beliefs; concurrent first-callers must not double-seed.
    assert all(c == 2 for c in counts)
