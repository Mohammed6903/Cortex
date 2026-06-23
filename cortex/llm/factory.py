"""Resolve a provider string into a concrete :class:`LLMClient`.

Vendor adapters are imported lazily so the deterministic ``mock`` provider (and the whole
test/eval suite) needs none of the optional SDKs installed.
"""

from __future__ import annotations

from ..config import Config
from .base import LLMClient
from .mock import MockLLM


def build_llm(config: Config) -> LLMClient:
    provider = config.llm_provider.lower()

    if provider == "mock":
        return MockLLM()
    if provider == "vertex":
        from .vertex_gemini import VertexGeminiLLM

        return VertexGeminiLLM()
    if provider == "qwen":
        from .openai_compatible import QwenLLM

        return QwenLLM()
    if provider == "openai":
        from .openai_compatible import OpenAILLM

        return OpenAILLM()
    if provider == "claude":
        from .claude import ClaudeLLM

        return ClaudeLLM()

    raise ValueError(
        f"Unknown CORTEX_LLM_PROVIDER {config.llm_provider!r}; "
        "expected one of: mock, vertex, qwen, openai, claude"
    )
