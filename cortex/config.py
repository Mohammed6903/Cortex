"""Runtime configuration, sourced from environment with conservative defaults.

Everything tunable about the memory lifecycle lives here so the behaviour can be
inspected and adjusted without touching the engine.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Mapping, Optional


@dataclass(frozen=True)
class Config:
    # --- LLM selection ---
    llm_provider: str = "vertex"  # vertex | qwen | openai | claude | mock

    # --- Storage ---
    db_path: str = "cortex.db"
    # The persistent, single-user "brain" — real daily memory, never scratch/seeded.
    brain_db_path: str = "~/.cortex/brain.db"

    # --- Distillation ---
    distill_window: int = 20  # episodes considered per distillation pass

    # --- Reconciliation ---
    related_similarity: float = 0.35  # cosine >= this => candidate is "about" an existing belief
    duplicate_similarity: float = 0.86  # cosine >= this => consolidate, not a new belief
    reinforce_confidence_step: float = 0.08  # confidence bump per corroboration (capped at 1)

    # --- Retention / forgetting ---
    # A belief is eligible for hard prune only when archived AND below this salience
    # AND never retrieved.
    prune_salience_max: float = 0.2
    # Retention score at/below this demotes active -> dormant; dormant -> archived.
    dormant_retention_max: float = 0.35
    archive_retention_max: float = 0.15
    # How strongly each signal weighs into the retention score (need not sum to 1).
    w_salience: float = 0.5
    w_reinforcement: float = 0.3
    w_recency: float = 0.2
    recency_halflife_days: float = 14.0

    @staticmethod
    def from_env(env: Optional[Mapping[str, str]] = None) -> "Config":
        e = os.environ if env is None else env
        d = Config()  # defaults

        def f(key: str, default: float) -> float:
            return float(e[key]) if key in e else default

        def i(key: str, default: int) -> int:
            return int(e[key]) if key in e else default

        return Config(
            llm_provider=e.get("CORTEX_LLM_PROVIDER", d.llm_provider),
            db_path=e.get("CORTEX_DB_PATH", d.db_path),
            brain_db_path=e.get("CORTEX_BRAIN_DB_PATH", d.brain_db_path),
            distill_window=i("CORTEX_DISTILL_WINDOW", d.distill_window),
            related_similarity=f("CORTEX_RELATED_SIMILARITY", d.related_similarity),
            duplicate_similarity=f("CORTEX_DUPLICATE_SIMILARITY", d.duplicate_similarity),
            reinforce_confidence_step=f(
                "CORTEX_REINFORCE_STEP", d.reinforce_confidence_step
            ),
            prune_salience_max=f("CORTEX_PRUNE_SALIENCE_MAX", d.prune_salience_max),
            dormant_retention_max=f(
                "CORTEX_DORMANT_RETENTION_MAX", d.dormant_retention_max
            ),
            archive_retention_max=f(
                "CORTEX_ARCHIVE_RETENTION_MAX", d.archive_retention_max
            ),
            w_salience=f("CORTEX_W_SALIENCE", d.w_salience),
            w_reinforcement=f("CORTEX_W_REINFORCEMENT", d.w_reinforcement),
            w_recency=f("CORTEX_W_RECENCY", d.w_recency),
            recency_halflife_days=f(
                "CORTEX_RECENCY_HALFLIFE_DAYS", d.recency_halflife_days
            ),
        )
