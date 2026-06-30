"""Ask / decide — the second-brain's voice.

Given a question, assemble a Critical Recall context (see :mod:`cortex.recall`) and have the
LLM answer **in the first person as the owner**, grounded ONLY in the recalled beliefs and the
owner's voice, with citations. Two shapes:

- ``decide`` — recommend the most suitable action for the situation (ranked options, the why,
  confidence, surfaced conflicts), suited to the owner's goals/preferences/constraints.
- ``draft``  — write a response/message in the owner's voice, ready to send with light edits.
- ``auto``   — pick ``draft`` for "write/reply/message…"-shaped asks, else ``decide``.

Every cited belief is ``touch``ed (retention feedback): being used to answer keeps it warm.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Optional

from .models import Belief
from .recall import RecallContext, build_recall_context
from .store import beliefs as belief_store

DECIDE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "recommendation": {"type": "string"},
        "options": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "action": {"type": "string"},
                    "rationale": {"type": "string"},
                    "fit": {"type": "string"},
                    "tradeoffs": {"type": "string"},
                },
                "required": ["action", "rationale"],
            },
        },
        "confidence": {"type": "number"},
        "conflicts": {"type": "array", "items": {"type": "string"}},
        "cited_belief_ids": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["recommendation", "cited_belief_ids"],
}

DRAFT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "draft": {"type": "string"},
        "tone_notes": {"type": "string"},
        "cited_belief_ids": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["draft", "cited_belief_ids"],
}

_DRAFT_HINT = re.compile(
    r"\b(draft|write|reply|respond|message|email|text|compose|dm|note to)\b", re.IGNORECASE
)


def route_mode(question: str) -> str:
    """Heuristic for ``auto``: writing tasks → draft, everything else → decide."""
    return "draft" if _DRAFT_HINT.search(question) else "decide"


def _render_belief(b: Belief) -> str:
    return (
        f"- [{b.id}] ({b.type.value}, conf {b.confidence:.2f}, sal {b.salience:.2f}"
        f"{f', reinforced x{b.reinforcement_count}' if b.reinforcement_count else ''}) "
        f"{b.statement}"
    )


def _render_context(ctx: RecallContext) -> str:
    lines: list[str] = []
    persona = ctx.persona
    if persona and (persona.authored_voice or persona.inferred_voice or persona.values_card):
        lines.append("# Your voice & values")
        if persona.authored_voice:
            lines.append(f"voice (authored): {persona.authored_voice}")
        if persona.inferred_voice:
            lines.append(f"voice (observed): {persona.inferred_voice}")
        if persona.values_card:
            lines.append(f"values: {persona.values_card}")
        lines.append("")

    seen: set[str] = set()

    def section(title: str, group: list[Belief]) -> None:
        # Dedup across sections: show each belief once, under its highest-priority heading.
        fresh = [b for b in group if b.id not in seen]
        if fresh:
            seen.update(b.id for b in fresh)
            lines.append(f"# {title}")
            lines.extend(_render_belief(b) for b in fresh)
            lines.append("")

    section("Most relevant to this", ctx.semantic)
    section("Core truths & constraints (must respect)", ctx.core)
    section("Current goals", ctx.goals)
    section("People involved", ctx.relationships)
    return "\n".join(lines).strip()


def _build_prompt(ctx: RecallContext, mode: str) -> str:
    context = _render_context(ctx)
    if mode == "draft":
        task = (
            "Write a response/message I can send, in MY voice (use the voice & values above). "
            "Keep it natural and true to how I'd actually put it. Cite the belief ids that shaped it."
        )
    else:
        task = (
            "Recommend what I should do, suited to MY goals, preferences, and constraints above. "
            "Give a clear top recommendation, a few concrete options (action, rationale, fit, "
            "tradeoffs), your confidence 0-1, and call out any conflicts or unknowns honestly. "
            "Cite the belief ids that drove each part."
        )
    return (
        "You are ME — my own second brain. Speak in the first person AS me, never as an "
        "assistant. Ground everything ONLY in what is known about me below; if the memory is "
        "thin, say so rather than inventing. Only cite belief ids that appear below.\n\n"
        f"{context}\n\n"
        f"# Question\n{ctx.question}\n\n# Task\n{task}"
    )


def answer(
    engine,
    question: str,
    mode: str = "auto",
    now: Optional[datetime] = None,
    *,
    k: int = 8,
    budget: int = 24,
) -> dict[str, Any]:
    from datetime import timezone

    moment = now or datetime.now(timezone.utc)
    resolved = route_mode(question) if mode == "auto" else mode

    ctx = build_recall_context(engine, question, moment, engine.config, k=k, budget=budget)
    prompt = _build_prompt(ctx, resolved)
    schema = DRAFT_SCHEMA if resolved == "draft" else DECIDE_SCHEMA
    result = engine.llm.extract_structured(prompt, schema)

    # Keep only citations that are real, in-context beliefs.
    known = ctx.belief_ids()
    cited = [bid for bid in result.get("cited_belief_ids", []) if bid in known]
    result["cited_belief_ids"] = cited

    # Retention feedback: every cited belief was just *used*.
    for bid in cited:
        belief_store.touch(engine.conn, bid, moment)

    result["mode"] = resolved
    result["recalled"] = [
        {"id": b.id, "type": b.type.value, "statement": b.statement} for b in ctx.all_beliefs()
    ]
    return result
