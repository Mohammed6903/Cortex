"""The Cortex facade — wires ingestion, distillation, reconciliation, retention, and
retrieval into one object that the API, CLI, and evals all drive.

The flow is:  ingest episodes  →  learn (distill + reconcile)  →  maintain (consolidate +
forget)  →  retrieve.  Time is passed in explicitly so demos and evals are reproducible.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from .config import Config
from .ingestion import feed
from .lifecycle import retention
from .lifecycle.distiller import distill
from .lifecycle.reconciler import ReconcileResult, consolidate, reconcile
from .llm.base import LLMClient
from .models import Belief, BeliefEvent, Episode, Tier
from .retrieval import retrieve as _retrieve
from .store import beliefs, episodes


class Cortex:
    def __init__(self, conn, llm: LLMClient, config: Config) -> None:
        self.conn = conn
        self.llm = llm
        self.config = config

    # --- ingestion ---
    def ingest(self, events: list[dict[str, Any]]) -> list[Episode]:
        return feed.replay(self.conn, events)

    # --- learning ---
    def learn(self, now: Optional[datetime] = None) -> list[ReconcileResult]:
        window = episodes.recent(self.conn, self.config.distill_window)
        if not window:
            return []
        moment = now or window[-1].occurred_at
        candidates = distill(self.llm, window, self.config)
        return [
            reconcile(self.conn, self.llm, candidate, moment, self.config)
            for candidate in candidates
        ]

    # --- maintenance (forgetting) ---
    def maintain(
        self, now: Optional[datetime] = None, prune: bool = True
    ) -> dict[str, Any]:
        """Consolidate duplicates, demote by retention, and (optionally) hard-prune.

        ``prune=False`` is the safe mode for the persistent brain: beliefs may consolidate and
        cool down the tiers, but nothing is irreversibly deleted. Pruning (a real DELETE with
        no event) must be opted into explicitly.
        """
        moment = now or datetime.now(timezone.utc)
        merged = consolidate(self.conn, self.config, moment)
        demoted = retention.apply_retention(self.conn, self.config, moment)
        pruned = retention.prune(self.conn, self.config, moment) if prune else []
        return {"merged": merged, "demoted": demoted, "pruned": pruned}

    # --- retrieval ---
    def retrieve(self, query: str, k: int = 5, now: Optional[datetime] = None) -> list[Belief]:
        moment = now or datetime.now(timezone.utc)
        return _retrieve(self.conn, self.llm, query, k, moment, self.config)

    # --- ask / decide (second-brain voice) ---
    def ask(
        self, question: str, mode: str = "auto", now: Optional[datetime] = None
    ) -> dict[str, Any]:
        from .ask import answer  # local import avoids an import cycle

        return answer(self, question, mode=mode, now=now)

    # --- inspection ---
    def snapshot(self) -> list[Belief]:
        """Currently-held beliefs: active tier with an open validity window."""
        return [
            b
            for b in beliefs.all_beliefs(self.conn, tier=Tier.active)
            if b.validity_end is None
        ]

    def all_beliefs(self) -> list[Belief]:
        return beliefs.all_beliefs(self.conn)

    def timeline(self, belief_id: str) -> list[BeliefEvent]:
        return beliefs.events(self.conn, belief_id)
