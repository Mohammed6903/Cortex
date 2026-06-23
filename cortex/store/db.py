"""SQLite connection and schema.

One file, fully inspectable — no graph database. Relationships between beliefs are kept in
the ``links`` table, which is all the graph expressiveness Cortex needs. Embeddings live in
``vectors`` as JSON arrays (small dim; brute-force cosine in Python keeps the demo portable).
"""

from __future__ import annotations

import sqlite3

SCHEMA = """
CREATE TABLE IF NOT EXISTS episodes (
    id          TEXT PRIMARY KEY,
    source      TEXT NOT NULL,
    kind        TEXT NOT NULL,
    payload     TEXT NOT NULL DEFAULT '{}',   -- JSON
    occurred_at TEXT NOT NULL,
    ingested_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS beliefs (
    id                  TEXT PRIMARY KEY,
    type                TEXT NOT NULL,
    statement           TEXT NOT NULL,
    confidence          REAL NOT NULL,
    salience            REAL NOT NULL,
    tier                TEXT NOT NULL DEFAULT 'active',
    validity_start      TEXT NOT NULL,
    validity_end        TEXT,
    reinforcement_count INTEGER NOT NULL DEFAULT 0,
    last_accessed_at    TEXT,
    superseded_by       TEXT REFERENCES beliefs(id),
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS belief_episodes (
    belief_id  TEXT NOT NULL REFERENCES beliefs(id) ON DELETE CASCADE,
    episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    PRIMARY KEY (belief_id, episode_id)
);

CREATE TABLE IF NOT EXISTS belief_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    belief_id  TEXT NOT NULL REFERENCES beliefs(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    detail     TEXT NOT NULL DEFAULT '{}',    -- JSON
    at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS links (
    src_belief_id TEXT NOT NULL REFERENCES beliefs(id) ON DELETE CASCADE,
    dst_belief_id TEXT NOT NULL REFERENCES beliefs(id) ON DELETE CASCADE,
    relation      TEXT NOT NULL,
    PRIMARY KEY (src_belief_id, dst_belief_id, relation)
);

CREATE TABLE IF NOT EXISTS vectors (
    belief_id TEXT PRIMARY KEY REFERENCES beliefs(id) ON DELETE CASCADE,
    vector    TEXT NOT NULL                  -- JSON array of floats
);

CREATE INDEX IF NOT EXISTS idx_beliefs_tier ON beliefs(tier);
CREATE INDEX IF NOT EXISTS idx_belief_events_belief ON belief_events(belief_id, at);
CREATE INDEX IF NOT EXISTS idx_episodes_occurred ON episodes(occurred_at);
"""


def connect(db_path: str) -> sqlite3.Connection:
    # check_same_thread=False: FastAPI runs sync routes in a threadpool, so the single
    # connection is touched from multiple threads. SQLite serializes the writes itself.
    conn = sqlite3.connect(db_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    conn.commit()
