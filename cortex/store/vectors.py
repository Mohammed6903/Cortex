"""Brute-force vector search over the ``vectors`` table.

Embeddings are small (``EMBED_DIM``) and a personal memory holds at most thousands of
beliefs, so a linear cosine scan in Python is more than fast enough and keeps the whole
store inside one inspectable SQLite file.
"""

from __future__ import annotations

import json
import math
import sqlite3
from typing import Optional

from ..models import BeliefType, Tier


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    return dot / (na * nb) if na and nb else 0.0


def upsert(conn: sqlite3.Connection, belief_id: str, vector: list[float]) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO vectors(belief_id, vector) VALUES(?, ?)",
        (belief_id, json.dumps(vector)),
    )
    conn.commit()


def search(
    conn: sqlite3.Connection,
    vector: list[float],
    belief_type: Optional[BeliefType] = None,
    tier: Optional[Tier] = None,
    min_score: float = 0.0,
    top_k: Optional[int] = None,
) -> list[tuple[str, float]]:
    """Return ``(belief_id, score)`` pairs above ``min_score``, ranked high to low."""
    sql = (
        "SELECT v.belief_id AS bid, v.vector AS vec FROM vectors v "
        "JOIN beliefs b ON b.id = v.belief_id WHERE 1=1"
    )
    params: list[object] = []
    if belief_type is not None:
        sql += " AND b.type = ?"
        params.append(belief_type.value)
    if tier is not None:
        sql += " AND b.tier = ?"
        params.append(tier.value)

    scored: list[tuple[str, float]] = []
    for row in conn.execute(sql, params).fetchall():
        score = cosine(vector, json.loads(row["vec"]))
        if score >= min_score:
            scored.append((row["bid"], score))
    scored.sort(key=lambda t: t[1], reverse=True)
    return scored[:top_k] if top_k is not None else scored
