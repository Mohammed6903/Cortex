"""Scratch session holder for the HTTP API.

Two concerns are deliberately separated here:

1. **Safety — a disposable scratch DB.** The UI must never mutate a real, persisted store:
   ``maintain`` does irreversible demotions and hard-delete prunes. So the API is bound not
   to ``Config.db_path`` but to a throwaway *scratch* SQLite database owned by this module.

2. **Realness — a real LLM does the thinking.** Free-form ``learn`` from the UI runs against
   the configured real provider (``CORTEX_LLM_PROVIDER``, e.g. ``qwen``): the distiller and
   contradiction-judge are genuine model calls. Only *canned scenario seeding* stays
   deterministic — it replays ``evals/scenarios/<name>.json`` with scripted chat so the demo
   reproduces — and even then it uses the SAME embedder as live calls, so seeded and live
   beliefs share one vector space. If no provider/key is configured the session degrades to
   the deterministic mock (scenarios still work; free-form learn is disabled with a clear
   message) rather than crashing.

The active engine is cached here and surfaced through :func:`current_engine`, which
``cortex.api.get_engine`` delegates to.
"""

from __future__ import annotations

import dataclasses
import glob
import json
import os
import tempfile
import threading
from datetime import datetime
from typing import Any, Optional

from .config import Config
from .engine import Cortex
from .llm.factory import build_llm
from .llm.mock import MockLLM
from .store.db import connect, init_schema


class _Composite:
    """An LLM client that routes chat to one provider and embeddings to another.

    Lets us run real-provider *chat* (distillation, contradiction judgment) while keeping a
    single, consistent *embedder* across seeding and live use — so the vectors table never
    mixes embedding spaces/dimensions. Satisfies the ``LLMClient`` protocol.
    """

    def __init__(self, chat, embedder) -> None:
        self._chat = chat
        self._embedder = embedder

    def complete(self, prompt: str) -> str:
        return self._chat.complete(prompt)

    def extract_structured(self, prompt: str, schema: dict) -> Any:
        return self._chat.extract_structured(prompt, schema)

    def embed(self, texts: list[str]) -> list[list[float]]:
        return self._embedder.embed(texts)

# Scenarios live alongside the package: <repo>/evals/scenarios/*.json
_SCENARIO_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "evals", "scenarios"
)

# The scenario the scratch db defaults to on first use, so the UI is never empty.
DEFAULT_SCENARIO = "02_contradiction_branch"


def _dt(value: Optional[str]) -> Optional[datetime]:
    return datetime.fromisoformat(value) if value else None


def scenario_path(scenario: str) -> str:
    """Resolve a scenario *name* (with or without ``.json``) to an absolute path."""
    name = scenario if scenario.endswith(".json") else f"{scenario}.json"
    return os.path.join(_SCENARIO_DIR, name)


def available_scenarios() -> list[str]:
    """Bare scenario names (no extension) that ``reset`` will accept."""
    paths = sorted(glob.glob(os.path.join(_SCENARIO_DIR, "*.json")))
    return [os.path.splitext(os.path.basename(p))[0] for p in paths]


def _seed_scenario(engine: Cortex, path: str) -> None:
    """Replay one scenario file into ``engine``: ingest -> learn -> retrieve? -> maintain?.

    Mirrors ``evals.run_evals.run_scenario`` so seeded state matches the eval harness.
    """
    with open(path, "r", encoding="utf-8") as fh:
        scenario = json.load(fh)

    engine.ingest(scenario["events"])
    engine.learn(now=_dt(scenario.get("learn_now")))

    if "retrieve" in scenario:
        r = scenario["retrieve"]
        engine.retrieve(r["query"], k=r.get("k", 5), now=_dt(r.get("now")))

    if scenario.get("maintain_now") or scenario.get("maintain_rounds"):
        for _ in range(scenario.get("maintain_rounds", 1)):
            engine.maintain(now=_dt(scenario.get("maintain_now")))


class Session:
    """Owns the current scratch Cortex and the scenario it was seeded from."""

    def __init__(self, config: Optional[Config] = None) -> None:
        base = config or Config.from_env()
        # Force the scratch path: a dedicated temp file, never the configured prod db.
        scratch = os.environ.get("CORTEX_SCRATCH_DB_PATH") or os.path.join(
            tempfile.gettempdir(), "cortex_scratch.db"
        )
        # Which real provider the UI's free-form learn should use. Defaults to mock so tests
        # and key-less runs stay deterministic; set CORTEX_LLM_PROVIDER=qwen (etc.) to go live.
        self.requested_provider = (base.llm_provider or "mock").lower()
        self.config = dataclasses.replace(base, db_path=scratch)
        self.scenario: Optional[str] = None
        self._engine: Optional[Cortex] = None
        # One shared embedder for the whole session (deterministic local hashing), so seeded
        # and live beliefs land in the same vector space regardless of chat provider.
        self._embedder = MockLLM()
        self._chat = None  # the real (or mock) chat client, built lazily once
        self.active_provider = self.requested_provider
        self.degraded = False
        self.degrade_reason: Optional[str] = None
        # FastAPI runs sync routes in a threadpool, and the UI fires reset concurrently
        # (React dev double-effect + re-mount on navigation). Serialize all session
        # mutation so two resets can't interleave on the same scratch db.
        self._lock = threading.RLock()

    @property
    def db_path(self) -> str:
        return self.config.db_path

    def _chat_client(self):
        """Build (once) the real chat provider, falling back to mock if unavailable."""
        if self._chat is not None:
            return self._chat
        if self.requested_provider == "mock":
            self._chat = MockLLM()
            self.active_provider, self.degraded = "mock", False
            return self._chat
        try:
            cfg = dataclasses.replace(self.config, llm_provider=self.requested_provider)
            self._chat = build_llm(cfg)
            self.active_provider, self.degraded = self.requested_provider, False
        except Exception as exc:  # no key / SDK missing — degrade, don't crash
            self._chat = MockLLM()
            self.active_provider, self.degraded = "mock", True
            self.degrade_reason = (
                f"{self.requested_provider!r} unavailable ({exc}); "
                f"set the provider's API key and reset. Seeded scenarios still work; "
                f"free-form learn is disabled in mock mode."
            )
        return self._chat

    def _live_llm(self):
        """Real chat + the shared hashing embedder, for the UI's free-form actions."""
        return _Composite(self._chat_client(), self._embedder)

    def _seed_llm(self, scripted: Optional[list]):
        """Scripted (deterministic) chat + the shared embedder, for canned scenario seeding."""
        return _Composite(MockLLM(structured=list(scripted or [])), self._embedder)

    def engine(self) -> Cortex:
        """The active scratch engine, seeding a default scenario on first use."""
        with self._lock:
            # Double-checked under the lock so concurrent first-callers don't both seed.
            if self._engine is None:
                self._reset_locked(DEFAULT_SCENARIO)
            assert self._engine is not None
            return self._engine

    def reset(self, scenario: Optional[str] = None) -> dict[str, Any]:
        """Drop and recreate the scratch db, optionally re-seeding from a scenario.

        Returns ``{ok, beliefs, db}`` — the belief count is over *all* tiers so the UI
        can confirm a non-empty seed (including dormant/archived history).
        """
        with self._lock:
            return self._reset_locked(scenario)

    def _reset_locked(self, scenario: Optional[str]) -> dict[str, Any]:
        # Validate the scenario BEFORE tearing down the current engine, so a bad name
        # leaves the existing session intact instead of wiping it.
        scripted: Optional[list] = None
        path: Optional[str] = None
        if scenario:
            path = scenario_path(scenario)
            if not os.path.exists(path):
                raise FileNotFoundError(
                    f"unknown scenario {scenario!r}; available: {available_scenarios()}"
                )
            with open(path, "r", encoding="utf-8") as fh:
                scripted = list(json.load(fh).get("llm_structured", []))

        # Drop the reference but do NOT force-close the old connection: another threadpool
        # request may still be mid-query on it. On Linux, unlinking the db file below leaves
        # that open connection working on the now-anonymous inode, so in-flight reads finish
        # cleanly while new requests get the fresh engine; the old conn is closed by GC.
        self._engine = None

        # A real (on-disk) scratch db is dropped by deleting the file (unlink); a fresh file
        # is created by the next connect(). ``:memory:`` is fresh per connection — nothing to
        # remove. Use missing_ok so a concurrent reset that already unlinked it is harmless.
        if self.config.db_path != ":memory:":
            try:
                os.remove(self.config.db_path)
            except FileNotFoundError:
                pass

        # Build into a LOCAL engine first; only publish it once seeding succeeds, so a
        # failure can never leave a half-seeded engine bound to the session.
        conn = connect(self.config.db_path)
        init_schema(conn)
        live = self._live_llm()
        engine = Cortex(conn, live, self.config)

        if path is not None:
            # Seed canned scenarios deterministically with scripted chat, then hand the
            # engine back to the real provider for everything the user does next.
            engine.llm = self._seed_llm(scripted)
            _seed_scenario(engine, path)
            engine.llm = live

        self._engine = engine
        self.scenario = scenario
        return {
            "ok": True,
            "beliefs": len(engine.all_beliefs()),
            "db": self.config.db_path,
            "provider": self.active_provider,
            "degraded": self.degraded,
            "degrade_reason": self.degrade_reason,
        }


class BrainSession:
    """The persistent, single-user *brain* — real daily memory.

    Unlike :class:`Session` (the disposable scratch sandbox), this is bound to the real
    ``brain_db_path`` and is **never** wiped or seeded with canned scenarios. Its LLM is the
    configured real provider *directly* (chat AND embeddings — e.g. Qwen ``text-embedding-v3``),
    so the brain's vector space is genuinely semantic and self-consistent. If no real provider
    is configured it degrades to mock (reads still work; journaling/ask are gated with a clear
    message by the API).
    """

    def __init__(self, config: Optional[Config] = None) -> None:
        base = config or Config.from_env()
        brain_path = os.path.expanduser(base.brain_db_path)
        self.requested_provider = (base.llm_provider or "mock").lower()
        self.config = dataclasses.replace(base, db_path=brain_path)
        # Real (e.g. Qwen 1024-dim) embeddings have a far higher baseline cosine than the
        # lexical hash (~0.4 between unrelated texts vs ~0 for the hash), so the hashing-tuned
        # related/duplicate thresholds would treat nearly everything as related. Raise them for
        # a real provider — unless the user explicitly overrode them via env.
        if self.requested_provider != "mock":
            repl: dict[str, float] = {}
            if self.config.related_similarity == Config.related_similarity:
                repl["related_similarity"] = 0.55
            if self.config.duplicate_similarity == Config.duplicate_similarity:
                repl["duplicate_similarity"] = 0.90
            if repl:
                self.config = dataclasses.replace(self.config, **repl)
        self._engine: Optional[Cortex] = None
        self._lock = threading.RLock()
        self.active_provider = self.requested_provider
        self.degraded = False
        self.degrade_reason: Optional[str] = None

    @property
    def db_path(self) -> str:
        return self.config.db_path

    def _build_llm(self):
        if self.requested_provider == "mock":
            self.active_provider, self.degraded = "mock", False
            return MockLLM()
        try:
            llm = build_llm(
                dataclasses.replace(self.config, llm_provider=self.requested_provider)
            )
            self.active_provider, self.degraded = self.requested_provider, False
            return llm
        except Exception as exc:  # no key / SDK — degrade so reads still work
            self.active_provider, self.degraded = "mock", True
            self.degrade_reason = (
                f"{self.requested_provider!r} unavailable ({exc}); set the provider's API key "
                f"to enable journaling and ask. The brain still reads existing memory."
            )
            return MockLLM()

    def engine(self) -> Cortex:
        with self._lock:
            if self._engine is None:
                parent = os.path.dirname(self.db_path)
                if parent:
                    os.makedirs(parent, exist_ok=True)
                conn = connect(self.db_path)
                init_schema(conn)
                self._engine = Cortex(conn, self._build_llm(), self.config)
            return self._engine


# Process-wide scratch session. Lazily seeds on first ``engine()`` access.
_SESSION: Optional[Session] = None
_BRAIN: Optional[BrainSession] = None
_BRAIN_LOCK = threading.Lock()
# Guards singleton CREATION. Without it, a cold-start burst (the UI fires reset twice on
# mount) lets two threads each build their own Session — two separate locks, no
# serialization — and they collide seeding the same scratch db (UNIQUE constraint on
# beliefs.id). Double-checked so the common hot path stays lock-free.
_SESSION_LOCK = threading.Lock()


def get_session() -> Session:
    global _SESSION
    if _SESSION is None:
        with _SESSION_LOCK:
            if _SESSION is None:
                _SESSION = Session()
    return _SESSION


def current_engine() -> Cortex:
    """The engine ``cortex.api.get_engine`` returns — bound to the scratch session."""
    return get_session().engine()


def reset_session(scenario: Optional[str] = None) -> dict[str, Any]:
    return get_session().reset(scenario)


def get_brain_session() -> BrainSession:
    """The process-wide persistent brain (single user)."""
    global _BRAIN
    if _BRAIN is None:
        with _BRAIN_LOCK:
            if _BRAIN is None:
                _BRAIN = BrainSession()
    return _BRAIN


def brain_engine() -> Cortex:
    return get_brain_session().engine()
