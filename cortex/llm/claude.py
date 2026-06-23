"""Anthropic Claude adapter.

Anthropic offers no first-party embedding endpoint, so ``embed`` uses the deterministic
hashing embedding. Chat and structured extraction use the Messages API.
"""

from __future__ import annotations

import json
import os
from typing import Any

from .base import EMBED_DIM
from .embedding import hashing_embedding


class ClaudeLLM:
    def __init__(self) -> None:
        try:
            import anthropic
        except ImportError as exc:  # pragma: no cover - depends on optional extra
            raise RuntimeError(
                "The 'anthropic' package is required for the Claude provider. "
                "Install with: pip install 'cortex[claude]'"
            ) from exc

        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise RuntimeError("Set ANTHROPIC_API_KEY to use the Claude provider.")
        self._client = anthropic.Anthropic(api_key=api_key)
        self.chat_model = os.environ.get("CORTEX_CLAUDE_MODEL", "claude-sonnet-4-6")
        self._max_tokens = int(os.environ.get("CORTEX_CLAUDE_MAX_TOKENS", "2048"))

    def complete(self, prompt: str) -> str:
        msg = self._client.messages.create(
            model=self.chat_model,
            max_tokens=self._max_tokens,
            messages=[{"role": "user", "content": prompt}],
        )
        return "".join(block.text for block in msg.content if block.type == "text")

    def extract_structured(self, prompt: str, schema: dict[str, Any]) -> Any:
        instruction = (
            prompt
            + "\n\nReturn ONLY a JSON object matching this schema, with no prose:\n"
            + json.dumps(schema)
        )
        text = self.complete(instruction).strip()
        # Tolerate a fenced code block if the model wraps the JSON.
        if text.startswith("```"):
            text = text.split("```")[1].lstrip("json").strip()
        return json.loads(text)

    def embed(self, texts: list[str]) -> list[list[float]]:
        return [hashing_embedding(t, EMBED_DIM) for t in texts]
