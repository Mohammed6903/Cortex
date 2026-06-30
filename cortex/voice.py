"""Keep learning the owner's voice from what they actually write.

Pairs with the *authored* voice card: this summarizes the owner's tone/style/values from
recent journal entries so ``ask`` drafts sound more like them over time. A plain ``complete``
call (no schema) writing a short style guide, stored as ``inferred_voice``.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from .store import episodes as episode_store
from .store import profile as profile_store


def _recent_journal_texts(conn, limit: int) -> list[str]:
    texts: list[str] = []
    for ep in episode_store.recent(conn, limit * 3):  # over-fetch, then keep journal entries
        if ep.source == "journal":
            t = ep.payload.get("text")
            if isinstance(t, str) and t.strip():
                texts.append(t.strip())
    return texts[-limit:]


def refresh_inferred_voice(
    engine, now: Optional[datetime] = None, *, limit: int = 30
) -> profile_store.Profile:
    """Summarize the owner's writing voice from recent journal entries and store it."""
    from datetime import timezone

    moment = now or datetime.now(timezone.utc)
    texts = _recent_journal_texts(engine.conn, limit)
    if not texts:
        return profile_store.get_profile(engine.conn)

    sample = "\n".join(f"- {t}" for t in texts)
    prompt = (
        "Below are recent things the user wrote in their own words. In 2-4 sentences, describe "
        "their WRITING VOICE — tone, sentence length/rhythm, vocabulary, directness, humor — and "
        "the VALUES that recur. Write it as a concise style guide an assistant could follow to "
        "sound like them. Do not quote the entries; generalize.\n\n"
        f"{sample}"
    )
    summary = engine.llm.complete(prompt).strip()
    return profile_store.set_inferred(engine.conn, inferred_voice=summary, now=moment)
