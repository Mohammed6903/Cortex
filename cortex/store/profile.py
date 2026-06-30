"""The owner's voice/persona — what makes answers sound like *them*, not generic.

Cortex tracks *what* you believe (beliefs); this tracks *how* you speak and what you value.
Two parts, both injected into every ``ask``:
- ``authored_voice`` / ``values_card`` — written by the owner, edited rarely.
- ``inferred_voice`` — periodically summarized by the LLM from recent journal entries.

A single row keyed ``'me'`` (this is a single-user brain).
"""

from __future__ import annotations

import sqlite3
from datetime import datetime
from typing import Optional

from pydantic import BaseModel

_ID = "me"


class Profile(BaseModel):
    authored_voice: str = ""
    inferred_voice: str = ""
    values_card: str = ""
    updated_at: Optional[str] = None


def get_profile(conn: sqlite3.Connection) -> Profile:
    row = conn.execute(
        "SELECT authored_voice, inferred_voice, values_card, updated_at "
        "FROM profile WHERE id = ?",
        (_ID,),
    ).fetchone()
    if row is None:
        return Profile()
    return Profile(
        authored_voice=row["authored_voice"],
        inferred_voice=row["inferred_voice"],
        values_card=row["values_card"],
        updated_at=row["updated_at"],
    )


def _upsert(conn: sqlite3.Connection, **fields: str) -> None:
    """Insert the row if absent, then update only the provided columns."""
    conn.execute("INSERT OR IGNORE INTO profile(id) VALUES(?)", (_ID,))
    assignments = ", ".join(f"{k} = ?" for k in fields)
    conn.execute(
        f"UPDATE profile SET {assignments} WHERE id = ?",
        (*fields.values(), _ID),
    )
    conn.commit()


def set_authored(
    conn: sqlite3.Connection,
    authored_voice: str,
    values_card: str,
    now: datetime,
) -> Profile:
    _upsert(
        conn,
        authored_voice=authored_voice,
        values_card=values_card,
        updated_at=now.isoformat(),
    )
    return get_profile(conn)


def set_inferred(
    conn: sqlite3.Connection, inferred_voice: str, now: datetime
) -> Profile:
    _upsert(conn, inferred_voice=inferred_voice, updated_at=now.isoformat())
    return get_profile(conn)
