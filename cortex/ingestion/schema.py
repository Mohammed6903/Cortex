"""Canonical activity-event input and its normalization into an immutable Episode.

A connector (or the synthetic feed) emits ``ActivityEvent``s. Normalization stamps each
with a content-derived id, which makes ingestion idempotent: replaying the same event never
creates a duplicate episode.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field

from ..models import Episode


class ActivityEvent(BaseModel):
    source: str
    kind: str
    payload: dict[str, Any] = Field(default_factory=dict)
    occurred_at: datetime


def _content_id(event: ActivityEvent) -> str:
    canonical = json.dumps(
        {
            "source": event.source,
            "kind": event.kind,
            "payload": event.payload,
            "occurred_at": event.occurred_at.isoformat(),
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    digest = hashlib.sha1(canonical.encode("utf-8")).hexdigest()[:12]
    return f"ep_{digest}"


def normalize_event(event: ActivityEvent, ingested_at: datetime) -> Episode:
    return Episode(
        id=_content_id(event),
        source=event.source,
        kind=event.kind,
        payload=event.payload,
        occurred_at=event.occurred_at,
        ingested_at=ingested_at,
    )
