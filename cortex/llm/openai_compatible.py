"""OpenAI-compatible adapters: vanilla OpenAI and Alibaba's Qwen Cloud.

Qwen Cloud exposes an OpenAI-compatible endpoint, so both providers share one
implementation and differ only in base URL, API-key env var, and default models.
Get a Qwen key at https://home.qwencloud.com/api-keys (Alibaba Cloud Model Studio).
"""

from __future__ import annotations

import json
import os
from typing import Any

from .base import EMBED_DIM
from .embedding import hashing_embedding


class _OpenAICompatibleLLM:
    base_url: str | None = None
    api_key_env: str = "OPENAI_API_KEY"
    chat_model: str = "gpt-4o-mini"
    embed_model: str | None = "text-embedding-3-small"

    def __init__(self) -> None:
        try:
            from openai import OpenAI
        except ImportError as exc:  # pragma: no cover - depends on optional extra
            raise RuntimeError(
                "The 'openai' package is required for this provider. "
                "Install with: pip install 'cortex[openai]'"
            ) from exc

        api_key = os.environ.get(self.api_key_env)
        if not api_key:
            raise RuntimeError(f"Set {self.api_key_env} to use this provider.")
        self._client = OpenAI(api_key=api_key, base_url=self.base_url)

    def complete(self, prompt: str) -> str:
        resp = self._client.chat.completions.create(
            model=self.chat_model,
            messages=[{"role": "user", "content": prompt}],
        )
        return resp.choices[0].message.content or ""

    def extract_structured(self, prompt: str, schema: dict[str, Any]) -> Any:
        instruction = (
            prompt
            + "\n\nReturn ONLY a JSON object matching this schema:\n"
            + json.dumps(schema)
        )
        resp = self._client.chat.completions.create(
            model=self.chat_model,
            messages=[{"role": "user", "content": instruction}],
            response_format={"type": "json_object"},
        )
        return json.loads(resp.choices[0].message.content or "{}")

    def embed(self, texts: list[str]) -> list[list[float]]:
        if not self.embed_model:
            return [hashing_embedding(t, EMBED_DIM) for t in texts]
        resp = self._client.embeddings.create(model=self.embed_model, input=texts)
        return [item.embedding for item in resp.data]


class OpenAILLM(_OpenAICompatibleLLM):
    base_url = None  # default OpenAI endpoint
    api_key_env = "OPENAI_API_KEY"
    chat_model = os.environ.get("CORTEX_OPENAI_MODEL", "gpt-4o-mini")
    embed_model = os.environ.get("CORTEX_OPENAI_EMBED_MODEL", "text-embedding-3-small")


class QwenLLM(_OpenAICompatibleLLM):
    base_url = os.environ.get(
        "CORTEX_QWEN_BASE_URL",
        "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    )
    api_key_env = "DASHSCOPE_API_KEY"
    chat_model = os.environ.get("CORTEX_QWEN_MODEL", "qwen-plus")
    embed_model = os.environ.get("CORTEX_QWEN_EMBED_MODEL", "text-embedding-v3")
