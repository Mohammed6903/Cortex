"""Domain types for Cortex.

Three layers of memory, mirrored here as plain typed records:

- ``Episode``  — an immutable observation drawn from the activity feed.
- ``Belief``   — a derived, typed assertion about the user, reconciled over time.
- ``BeliefEvent`` — an append-only audit row describing one lifecycle transition.
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, Field


class BeliefType(str, Enum):
    """The kinds of thing Cortex is willing to believe about a user."""

    preference = "preference"
    fact = "fact"
    goal = "goal"
    relationship = "relationship"
    transient_state = "transient_state"


class Tier(str, Enum):
    """Retention tiers. Beliefs are demoted down this ladder, not deleted on a clock."""

    active = "active"
    dormant = "dormant"
    archived = "archived"


class BeliefEventType(str, Enum):
    """Every transition a belief can undergo. Powers the inspector timeline."""

    formed = "formed"
    reinforced = "reinforced"
    contradicted = "contradicted"
    superseded = "superseded"
    merged = "merged"
    demoted = "demoted"
    promoted = "promoted"
    pruned = "pruned"


class Episode(BaseModel):
    """An atomic observation. Immutable once written — ground truth and provenance."""

    id: str
    source: str
    kind: str
    payload: dict[str, Any] = Field(default_factory=dict)
    occurred_at: datetime
    ingested_at: datetime


class Belief(BaseModel):
    """A derived assertion about the user, carrying its own lifecycle state."""

    id: str
    type: BeliefType
    statement: str
    confidence: float = Field(ge=0.0, le=1.0)
    salience: float = Field(ge=0.0, le=1.0)
    tier: Tier = Tier.active
    validity_start: datetime
    validity_end: Optional[datetime] = None
    reinforcement_count: int = 0
    last_accessed_at: Optional[datetime] = None
    superseded_by: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class BeliefEvent(BaseModel):
    """One row in a belief's audit log."""

    belief_id: str
    event_type: BeliefEventType
    detail: dict[str, Any] = Field(default_factory=dict)
    at: datetime
    id: Optional[int] = None
