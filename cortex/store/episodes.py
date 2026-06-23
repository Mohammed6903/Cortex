"""Persistence for the immutable episodic log."""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime

from ..models import Episode


def _row_to_episode(row: sqlite3.Row) -> Episode:
    return Episode(
        id=row["id"],
        source=row["source"],
        kind=row["kind"],
        payload=json.loads(row["payload"]),
        occurred_at=datetime.fromisoformat(row["occurred_at"]),
        ingested_at=datetime.fromisoformat(row["ingested_at"]),
    )


def append(conn: sqlite3.Connection, episode: Episode) -> bool:
    """Append an episode. Returns True if newly inserted, False if it already existed."""
    cur = conn.execute(
        "INSERT OR IGNORE INTO episodes(id, source, kind, payload, occurred_at, ingested_at) "
        "VALUES(?, ?, ?, ?, ?, ?)",
        (
            episode.id,
            episode.source,
            episode.kind,
            json.dumps(episode.payload, sort_keys=True),
            episode.occurred_at.isoformat(),
            episode.ingested_at.isoformat(),
        ),
    )
    conn.commit()
    return cur.rowcount > 0


def get(conn: sqlite3.Connection, episode_id: str) -> Episode | None:
    row = conn.execute("SELECT * FROM episodes WHERE id = ?", (episode_id,)).fetchone()
    return _row_to_episode(row) if row else None


def recent(conn: sqlite3.Connection, limit: int) -> list[Episode]:
    """The most recent ``limit`` episodes, returned in chronological (ascending) order."""
    rows = conn.execute(
        "SELECT * FROM episodes ORDER BY occurred_at DESC, id DESC LIMIT ?", (limit,)
    ).fetchall()
    return [_row_to_episode(r) for r in reversed(rows)]


def count(conn: sqlite3.Connection) -> int:
    return conn.execute("SELECT COUNT(*) FROM episodes").fetchone()[0]
