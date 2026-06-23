"""The LLM seam.

Everything the engine needs from a model is expressed here as a tiny protocol, so the
lifecycle logic never imports a vendor SDK. Adapters (Vertex Gemini, Qwen, OpenAI, Claude)
and the deterministic ``MockLLM`` all satisfy this interface.
"""

from __future__ import annotations

from typing import Any, Protocol, runtime_checkable

EMBED_DIM = 64


@runtime_checkable
class LLMClient(Protocol):
    def complete(self, prompt: str) -> str:
        """Free-form completion."""
        ...

    def extract_structured(self, prompt: str, schema: dict[str, Any]) -> Any:
        """Return a structured object conforming to ``schema`` (a JSON schema)."""
        ...

    def embed(self, texts: list[str]) -> list[list[float]]:
        """Return one embedding vector per input text."""
        ...
