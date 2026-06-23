"""Synthetic activity-feed replayer.

In place of real OS/browser/calendar connectors, Cortex replays scripted event streams
from JSON scenarios. Replay is deterministic — ``ingested_at`` defaults to each event's
``occurred_at`` — so demos and evals reproduce exactly.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from ..store import episodes
from .schema import ActivityEvent, normalize_event


def load_events(path: str) -> list[dict[str, Any]]:
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    return data["events"] if isinstance(data, dict) else data


def replay(conn: sqlite3.Connection, events: list[dict[str, Any]]):
    """Normalize and append each event. Returns the resulting Episodes in feed order."""
    result = []
    for raw in events:
        event = ActivityEvent(**raw)
        # Deterministic ingest time keeps replays reproducible.
        episode = normalize_event(event, ingested_at=event.occurred_at)
        episodes.append(conn, episode)
        result.append(episode)
    return result
