"""Distillation: turn recent episodes into candidate beliefs.

The distiller is pure — it reads episodes and asks the LLM for structured belief candidates.
It never touches the database. Persisting, reinforcing, and reconciling those candidates is
the reconciler's job, which keeps this step easy to test and reason about.
"""

from __future__ import annotations

import json
from typing import Any

from pydantic import BaseModel, Field

from ..config import Config
from ..llm.base import LLMClient
from ..models import BeliefType, Episode

# JSON schema handed to the model. Adapters that support structured output enforce it;
# the mock just replays canned objects shaped like this.
BELIEF_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "beliefs": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "type": {"enum": [t.value for t in BeliefType]},
                    "statement": {"type": "string"},
                    "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                    "salience": {"type": "number", "minimum": 0, "maximum": 1},
                    "source_episode_ids": {
                        "type": "array",
                        "items": {"type": "string"},
                    },
                },
                "required": ["type", "statement", "confidence", "salience"],
            },
        }
    },
    "required": ["beliefs"],
}

_PROMPT_HEADER = """You maintain a model of a single user from their digital activity.
Read the recent activity below and extract durable beliefs about the user — their
preferences, facts about them, goals, relationships, and transient states. Be conservative:
only assert what the evidence supports. For each belief cite the ids of the episodes that
justify it.

Recent activity:
"""


def _render_episodes(episodes: list[Episode]) -> str:
    lines = []
    for ep in episodes:
        lines.append(
            f"- [{ep.id}] {ep.occurred_at.isoformat()} {ep.source}/{ep.kind} "
            f"{json.dumps(ep.payload, sort_keys=True)}"
        )
    return "\n".join(lines)


def build_prompt(episodes: list[Episode]) -> str:
    return _PROMPT_HEADER + _render_episodes(episodes)


class CandidateBelief(BaseModel):
    type: BeliefType
    statement: str
    confidence: float = Field(ge=0.0, le=1.0)
    salience: float = Field(ge=0.0, le=1.0)
    source_episode_ids: list[str] = Field(default_factory=list)


def distill(llm: LLMClient, episodes: list[Episode], config: Config) -> list[CandidateBelief]:
    if not episodes:
        return []

    known_ids = [e.id for e in episodes]
    known = set(known_ids)
    result = llm.extract_structured(build_prompt(episodes), BELIEF_SCHEMA)

    candidates: list[CandidateBelief] = []
    for raw in result.get("beliefs", []):
        cited = [i for i in raw.get("source_episode_ids", []) if i in known]
        # Fall back to the whole window if the model cited nothing usable.
        provenance = cited if cited else list(known_ids)
        candidates.append(
            CandidateBelief(
                type=BeliefType(raw["type"]),
                statement=raw["statement"],
                confidence=raw["confidence"],
                salience=raw["salience"],
                source_episode_ids=provenance,
            )
        )
    return candidates
