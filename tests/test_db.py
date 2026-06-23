from cortex.store.db import connect, init_schema


def _tables(conn):
    rows = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()
    return {r["name"] for r in rows}


def test_init_schema_creates_all_tables():
    conn = connect(":memory:")
    init_schema(conn)
    assert {
        "episodes",
        "beliefs",
        "belief_episodes",
        "belief_events",
        "links",
        "vectors",
    } <= _tables(conn)


def test_init_schema_is_idempotent():
    conn = connect(":memory:")
    init_schema(conn)
    init_schema(conn)  # must not raise
    assert "beliefs" in _tables(conn)


def test_connection_enforces_foreign_keys():
    conn = connect(":memory:")
    assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1


def test_rows_are_accessible_by_column_name():
    conn = connect(":memory:")
    init_schema(conn)
    conn.execute(
        "INSERT INTO episodes(id, source, kind, payload, occurred_at, ingested_at) "
        "VALUES('e1','calendar','created','{}','2026-06-23T09:00:00','2026-06-23T09:00:01')"
    )
    row = conn.execute("SELECT * FROM episodes WHERE id='e1'").fetchone()
    assert row["source"] == "calendar"
