"""Deterministic, scriptable LLM for tests and offline evals.

``complete`` and ``extract_structured`` replay queued responses in order; ``embed`` uses
the deterministic hashing embedding. This lets the entire memory lifecycle be exercised
with zero network calls and fully reproducible results.
"""

from __future__ import annotations

from typing import Any

from .base import EMBED_DIM
from .embedding import hashing_embedding


class MockLLM:
    def __init__(
        self,
        completions: list[str] | None = None,
        structured: list[Any] | None = None,
    ) -> None:
        self._completions = list(completions or [])
        self._structured = list(structured or [])
        self.calls: list[tuple[str, str]] = []  # (method, prompt) audit for assertions

    def complete(self, prompt: str) -> str:
        self.calls.append(("complete", prompt))
        if not self._completions:
            raise AssertionError("MockLLM.complete called with no scripted responses left")
        return self._completions.pop(0)

    def extract_structured(self, prompt: str, schema: dict[str, Any]) -> Any:
        self.calls.append(("extract_structured", prompt))
        if not self._structured:
            raise AssertionError(
                "MockLLM.extract_structured called with no scripted responses left"
            )
        return self._structured.pop(0)

    def embed(self, texts: list[str]) -> list[list[float]]:
        return [hashing_embedding(t, EMBED_DIM) for t in texts]
