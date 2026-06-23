"""Persistence for beliefs, their provenance, lifecycle events, and vectors."""

from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import datetime
from typing import Any, Optional

from ..models import Belief, BeliefEvent, BeliefEventType, BeliefType, Tier

# ``CandidateBelief`` is imported lazily in type hints only to avoid a cycle.


def _belief_id(belief_type: BeliefType, statement: str, validity_start: datetime) -> str:
    raw = f"{belief_type.value}|{statement}|{validity_start.isoformat()}"
    return "bel_" + hashlib.sha1(raw.encode("utf-8")).hexdigest()[:12]


def _row_to_belief(row: sqlite3.Row) -> Belief:
    def _dt(v: Optional[str]) -> Optional[datetime]:
        return datetime.fromisoformat(v) if v else None

    return Belief(
        id=row["id"],
        type=BeliefType(row["type"]),
        statement=row["statement"],
        confidence=row["confidence"],
        salience=row["salience"],
        tier=Tier(row["tier"]),
        validity_start=datetime.fromisoformat(row["validity_start"]),
        validity_end=_dt(row["validity_end"]),
        reinforcement_count=row["reinforcement_count"],
        last_accessed_at=_dt(row["last_accessed_at"]),
        superseded_by=row["superseded_by"],
        created_at=_dt(row["created_at"]),
        updated_at=_dt(row["updated_at"]),
    )


def record_event(
    conn: sqlite3.Connection,
    belief_id: str,
    event_type: BeliefEventType,
    detail: dict[str, Any],
    at: datetime,
) -> None:
    conn.execute(
        "INSERT INTO belief_events(belief_id, event_type, detail, at) VALUES(?, ?, ?, ?)",
        (belief_id, event_type.value, json.dumps(detail, sort_keys=True), at.isoformat()),
    )
    conn.commit()


def form(
    conn: sqlite3.Connection,
    candidate: Any,  # CandidateBelief
    now: datetime,
    vector: Optional[list[float]] = None,
) -> Belief:
    """Persist a brand-new belief, its provenance, a ``formed`` event, and its vector."""
    belief = Belief(
        id=_belief_id(candidate.type, candidate.statement, now),
        type=candidate.type,
        statement=candidate.statement,
        confidence=candidate.confidence,
        salience=candidate.salience,
        tier=Tier.active,
        validity_start=now,
        reinforcement_count=0,
        created_at=now,
        updated_at=now,
    )
    conn.execute(
        "INSERT INTO beliefs(id, type, statement, confidence, salience, tier, "
        "validity_start, validity_end, reinforcement_count, last_accessed_at, "
        "superseded_by, created_at, updated_at) "
        "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            belief.id,
            belief.type.value,
            belief.statement,
            belief.confidence,
            belief.salience,
            belief.tier.value,
            belief.validity_start.isoformat(),
            None,
            belief.reinforcement_count,
            None,
            None,
            belief.created_at.isoformat(),
            belief.updated_at.isoformat(),
        ),
    )
    for ep_id in candidate.source_episode_ids:
        conn.execute(
            "INSERT OR IGNORE INTO belief_episodes(belief_id, episode_id) VALUES(?, ?)",
            (belief.id, ep_id),
        )
    if vector is not None:
        conn.execute(
            "INSERT OR REPLACE INTO vectors(belief_id, vector) VALUES(?, ?)",
            (belief.id, json.dumps(vector)),
        )
    conn.commit()
    record_event(
        conn,
        belief.id,
        BeliefEventType.formed,
        {"statement": belief.statement, "confidence": belief.confidence},
        now,
    )
    return belief


def add_provenance(
    conn: sqlite3.Connection, belief_id: str, episode_ids: list[str]
) -> None:
    for ep_id in episode_ids:
        conn.execute(
            "INSERT OR IGNORE INTO belief_episodes(belief_id, episode_id) VALUES(?, ?)",
            (belief_id, ep_id),
        )
    conn.commit()


def reinforce(
    conn: sqlite3.Connection,
    belief_id: str,
    *,
    confidence: float,
    salience: float,
    now: datetime,
    detail: dict[str, Any],
) -> None:
    """Corroborate an existing belief: raise confidence, count it, refresh recency.

    Corroboration counts as activity, so it refreshes ``last_accessed_at`` — fresh evidence
    keeps a belief hot the same way retrieval does.
    """
    conn.execute(
        "UPDATE beliefs SET confidence = ?, salience = ?, "
        "reinforcement_count = reinforcement_count + 1, last_accessed_at = ?, "
        "updated_at = ? WHERE id = ?",
        (confidence, salience, now.isoformat(), now.isoformat(), belief_id),
    )
    conn.commit()
    record_event(conn, belief_id, BeliefEventType.reinforced, detail, now)


def supersede(
    conn: sqlite3.Connection, old_id: str, new_id: str, now: datetime
) -> None:
    """A fact correction: the old belief was wrong. Archive it, link to the replacement."""
    conn.execute(
        "UPDATE beliefs SET tier = ?, superseded_by = ?, validity_end = ?, updated_at = ? "
        "WHERE id = ?",
        (Tier.archived.value, new_id, now.isoformat(), now.isoformat(), old_id),
    )
    conn.commit()
    record_event(conn, old_id, BeliefEventType.contradicted, {"by": new_id}, now)
    record_event(conn, old_id, BeliefEventType.superseded, {"by": new_id}, now)


def branch(conn: sqlite3.Connection, old_id: str, new_id: str, now: datetime) -> None:
    """An evolution over time: the old belief was true then, not now. Keep it as history."""
    conn.execute(
        "UPDATE beliefs SET tier = ?, superseded_by = ?, validity_end = ?, updated_at = ? "
        "WHERE id = ?",
        (Tier.dormant.value, new_id, now.isoformat(), now.isoformat(), old_id),
    )
    conn.commit()
    record_event(conn, old_id, BeliefEventType.contradicted, {"by": new_id, "kind": "branch"}, now)


def merge(
    conn: sqlite3.Connection, survivor_id: str, loser_id: str, now: datetime
) -> None:
    """Collapse two near-duplicate beliefs into ``survivor_id``; archive ``loser_id``."""
    survivor = get(conn, survivor_id)
    loser = get(conn, loser_id)
    if survivor is None or loser is None:
        return
    conn.execute(
        "UPDATE beliefs SET confidence = ?, salience = ?, "
        "reinforcement_count = ?, updated_at = ? WHERE id = ?",
        (
            max(survivor.confidence, loser.confidence),
            max(survivor.salience, loser.salience),
            survivor.reinforcement_count + loser.reinforcement_count + 1,
            now.isoformat(),
            survivor_id,
        ),
    )
    add_provenance(conn, survivor_id, provenance(conn, loser_id))
    conn.execute(
        "UPDATE beliefs SET tier = ?, superseded_by = ?, validity_end = ?, updated_at = ? "
        "WHERE id = ?",
        (Tier.archived.value, survivor_id, now.isoformat(), now.isoformat(), loser_id),
    )
    conn.commit()
    record_event(conn, loser_id, BeliefEventType.merged, {"into": survivor_id}, now)


def set_tier(
    conn: sqlite3.Connection,
    belief_id: str,
    tier: Tier,
    now: datetime,
    event_type: BeliefEventType,
    detail: Optional[dict[str, Any]] = None,
) -> None:
    conn.execute(
        "UPDATE beliefs SET tier = ?, updated_at = ? WHERE id = ?",
        (tier.value, now.isoformat(), belief_id),
    )
    conn.commit()
    record_event(conn, belief_id, event_type, detail or {"tier": tier.value}, now)


def touch(conn: sqlite3.Connection, belief_id: str, now: datetime) -> None:
    """Record that a belief was retrieved. This is the feedback that drives retention:
    accessing a belief keeps it hot, and a dormant belief is promoted back to active."""
    current = get(conn, belief_id)
    if current is None:
        return
    conn.execute(
        "UPDATE beliefs SET last_accessed_at = ?, updated_at = ? WHERE id = ?",
        (now.isoformat(), now.isoformat(), belief_id),
    )
    conn.commit()
    if current.tier is Tier.dormant:
        set_tier(conn, belief_id, Tier.active, now, BeliefEventType.promoted, {"reason": "accessed"})


def delete(conn: sqlite3.Connection, belief_id: str) -> None:
    conn.execute("DELETE FROM beliefs WHERE id = ?", (belief_id,))
    conn.commit()


def get(conn: sqlite3.Connection, belief_id: str) -> Optional[Belief]:
    row = conn.execute("SELECT * FROM beliefs WHERE id = ?", (belief_id,)).fetchone()
    return _row_to_belief(row) if row else None


def provenance(conn: sqlite3.Connection, belief_id: str) -> list[str]:
    rows = conn.execute(
        "SELECT episode_id FROM belief_episodes WHERE belief_id = ?", (belief_id,)
    ).fetchall()
    return [r["episode_id"] for r in rows]


def events(conn: sqlite3.Connection, belief_id: str) -> list[BeliefEvent]:
    rows = conn.execute(
        "SELECT * FROM belief_events WHERE belief_id = ? ORDER BY at, id", (belief_id,)
    ).fetchall()
    return [
        BeliefEvent(
            id=r["id"],
            belief_id=r["belief_id"],
            event_type=BeliefEventType(r["event_type"]),
            detail=json.loads(r["detail"]),
            at=datetime.fromisoformat(r["at"]),
        )
        for r in rows
    ]


def get_vector(conn: sqlite3.Connection, belief_id: str) -> Optional[list[float]]:
    row = conn.execute(
        "SELECT vector FROM vectors WHERE belief_id = ?", (belief_id,)
    ).fetchone()
    return json.loads(row["vector"]) if row else None


def all_beliefs(
    conn: sqlite3.Connection, tier: Optional[Tier] = None
) -> list[Belief]:
    if tier is None:
        rows = conn.execute("SELECT * FROM beliefs ORDER BY created_at, id").fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM beliefs WHERE tier = ? ORDER BY created_at, id", (tier.value,)
        ).fetchall()
    return [_row_to_belief(r) for r in rows]
