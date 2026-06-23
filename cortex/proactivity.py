"""A deliberately minimal proactive layer — just enough to show the loop exists.

The interesting claim of the source idea was *cross-session* proactivity: "this morning you
said YouTube was a distraction; you're on it again — want to refocus?" That requires memory
that persists across sessions, which Cortex has. This module demonstrates one rule over that
memory: when recent activity collides with a currently-held *transient state* (e.g. a known
distraction), it surfaces a nudge. A richer trigger engine is intentionally out of scope.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass

from .models import BeliefType, Episode, Tier
from .store import beliefs

_TOKEN = re.compile(r"[a-z0-9]+")
# Words too generic to count as a meaningful collision.
_STOPWORDS = {"by", "the", "a", "an", "of", "to", "in", "on", "and", "is", "with", "com", "www"}


@dataclass
class Nudge:
    belief_id: str
    message: str
    reason: str
    episode_id: str


def _tokens(text: str) -> set[str]:
    return {t for t in _TOKEN.findall(text.lower()) if t not in _STOPWORDS}


def evaluate(conn, recent_episodes: list[Episode]) -> list[Nudge]:
    states = [
        b
        for b in beliefs.all_beliefs(conn, tier=Tier.active)
        if b.type is BeliefType.transient_state and b.validity_end is None
    ]

    nudges: list[Nudge] = []
    for episode in recent_episodes:
        activity = _tokens(json.dumps(episode.payload))
        for belief in states:
            overlap = _tokens(belief.statement) & activity
            if overlap:
                topic = sorted(overlap)[0]
                nudges.append(
                    Nudge(
                        belief_id=belief.id,
                        message=(
                            f"Earlier you noted: \"{belief.statement}\". "
                            f"You're on {topic} again — want to refocus?"
                        ),
                        reason=f"recent activity overlaps a known transient state on '{topic}'",
                        episode_id=episode.id,
                    )
                )
    return nudges
