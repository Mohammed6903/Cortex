"""Reconciliation — the heart of Cortex.

A freshly distilled candidate belief is never blindly written. It is reconciled against
what is already known, by *evidence and contradiction* rather than a clock:

- **reinforce** — the candidate corroborates an existing belief: raise confidence, count it.
- **supersede** — the candidate contradicts a *fact* that was simply wrong: archive the old
  belief and link it to its replacement.
- **branch** — the candidate contradicts a *preference/goal/state* that has changed over
  time: keep the old belief as history (validity closed), make the new one current.
- **form** — nothing related, or an unrelated topic: a brand-new belief.

Every outcome leaves an audit trail in ``belief_events`` so the inspector can replay it.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Any, Optional

from ..config import Config
from ..llm.base import LLMClient
from ..models import BeliefType
from ..store import beliefs, vectors
from .distiller import CandidateBelief


class Relation(str, Enum):
    reinforces = "reinforces"
    contradicts = "contradicts"
    unrelated = "unrelated"


class Action(str, Enum):
    formed = "formed"
    reinforced = "reinforced"
    superseded = "superseded"
    branched = "branched"


@dataclass
class ReconcileResult:
    action: Action
    belief_id: str  # the resulting *active* belief
    prior_id: Optional[str] = None  # the existing belief that was matched, if any


_RELATION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "relation": {"enum": [r.value for r in Relation]},
        "reason": {"type": "string"},
    },
    "required": ["relation"],
}


def _classify(llm: LLMClient, candidate: CandidateBelief, existing_statement: str) -> Relation:
    prompt = (
        "Two statements describe the same user. Decide how the NEW one relates to the "
        "EXISTING one.\n"
        "- 'reinforces': the new statement supports or repeats the existing one.\n"
        "- 'contradicts': the new statement conflicts with or replaces the existing one.\n"
        "- 'unrelated': they are about different things.\n\n"
        f"EXISTING: {existing_statement}\n"
        f"NEW: {candidate.statement}\n"
    )
    result = llm.extract_structured(prompt, _RELATION_SCHEMA)
    return Relation(result["relation"])


def reconcile(
    conn,
    llm: LLMClient,
    candidate: CandidateBelief,
    now: datetime,
    config: Config,
) -> ReconcileResult:
    vector = llm.embed([candidate.statement])[0]

    related = vectors.search(
        conn,
        vector,
        belief_type=candidate.type,
        tier=None,  # match against the current active timeline only
        min_score=config.related_similarity,
    )
    # Only consider beliefs that are still current (not archived/superseded).
    related = [
        (bid, score)
        for bid, score in related
        if (b := beliefs.get(conn, bid)) is not None
        and b.superseded_by is None
        and b.validity_end is None
    ]

    if not related:
        return _form(conn, candidate, now, vector)

    match_id, _ = related[0]
    existing = beliefs.get(conn, match_id)
    relation = _classify(llm, candidate, existing.statement)

    if relation is Relation.reinforces:
        new_conf = min(1.0, existing.confidence + config.reinforce_confidence_step)
        new_sal = max(existing.salience, candidate.salience)
        beliefs.add_provenance(conn, match_id, candidate.source_episode_ids)
        beliefs.reinforce(
            conn,
            match_id,
            confidence=new_conf,
            salience=new_sal,
            now=now,
            detail={"from_confidence": existing.confidence, "to_confidence": new_conf},
        )
        return ReconcileResult(Action.reinforced, belief_id=match_id, prior_id=match_id)

    if relation is Relation.contradicts:
        new = beliefs.form(conn, candidate, now, vector=vector)
        if candidate.type is BeliefType.fact:
            beliefs.supersede(conn, old_id=match_id, new_id=new.id, now=now)
            return ReconcileResult(Action.superseded, belief_id=new.id, prior_id=match_id)
        beliefs.branch(conn, old_id=match_id, new_id=new.id, now=now)
        return ReconcileResult(Action.branched, belief_id=new.id, prior_id=match_id)

    # unrelated
    return _form(conn, candidate, now, vector)


def _form(conn, candidate: CandidateBelief, now: datetime, vector) -> ReconcileResult:
    new = beliefs.form(conn, candidate, now, vector=vector)
    return ReconcileResult(Action.formed, belief_id=new.id)


def consolidate(conn, config: Config, now: datetime) -> list[tuple[str, str]]:
    """Sweep active beliefs and collapse near-duplicates of the same type.

    Greedy and deterministic: within a type, the oldest belief of a duplicate cluster is the
    survivor; later ones are merged into it. Returns ``(loser_id, survivor_id)`` pairs.
    """
    from ..models import Tier  # local import to avoid a cycle at module load

    merged: list[tuple[str, str]] = []
    for btype in BeliefType:
        active = [b for b in beliefs.all_beliefs(conn, tier=Tier.active) if b.type is btype]
        active.sort(key=lambda b: (b.created_at, b.id))
        gone: set[str] = set()
        for i, survivor in enumerate(active):
            if survivor.id in gone:
                continue
            sv = beliefs.get_vector(conn, survivor.id)
            if sv is None:
                continue
            for other in active[i + 1:]:
                if other.id in gone:
                    continue
                ov = beliefs.get_vector(conn, other.id)
                if ov is None:
                    continue
                if vectors.cosine(sv, ov) >= config.duplicate_similarity:
                    beliefs.merge(conn, survivor_id=survivor.id, loser_id=other.id, now=now)
                    gone.add(other.id)
                    merged.append((other.id, survivor.id))
    return merged
