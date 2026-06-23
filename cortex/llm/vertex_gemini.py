"""Vertex AI (Gemini) adapter — the default provider.

Uses the unified ``google-genai`` SDK in Vertex mode. Authentication follows the standard
Google flow: ``GOOGLE_GENAI_USE_VERTEXAI=true`` plus ``GOOGLE_CLOUD_PROJECT`` /
``GOOGLE_CLOUD_LOCATION`` and application-default credentials. Falls back to the deterministic
hashing embedding if a dedicated embedding model is not configured.
"""

from __future__ import annotations

import json
import os
from typing import Any

from .base import EMBED_DIM
from .embedding import hashing_embedding


class VertexGeminiLLM:
    def __init__(self) -> None:
        try:
            from google import genai
        except ImportError as exc:  # pragma: no cover - depends on optional extra
            raise RuntimeError(
                "The 'google-genai' package is required for the Vertex provider. "
                "Install with: pip install 'cortex[vertex]'"
            ) from exc

        self._genai = genai
        self._client = genai.Client(
            vertexai=True,
            project=os.environ.get("GOOGLE_CLOUD_PROJECT"),
            location=os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1"),
        )
        self.chat_model = os.environ.get("CORTEX_VERTEX_MODEL", "gemini-2.0-flash")
        self.embed_model = os.environ.get("CORTEX_VERTEX_EMBED_MODEL", "text-embedding-004")

    def complete(self, prompt: str) -> str:
        resp = self._client.models.generate_content(model=self.chat_model, contents=prompt)
        return resp.text or ""

    def extract_structured(self, prompt: str, schema: dict[str, Any]) -> Any:
        from google.genai import types

        config = types.GenerateContentConfig(response_mime_type="application/json")
        instruction = (
            prompt
            + "\n\nReturn ONLY a JSON object matching this schema:\n"
            + json.dumps(schema)
        )
        resp = self._client.models.generate_content(
            model=self.chat_model, contents=instruction, config=config
        )
        return json.loads(resp.text or "{}")

    def embed(self, texts: list[str]) -> list[list[float]]:
        if not self.embed_model:
            return [hashing_embedding(t, EMBED_DIM) for t in texts]
        resp = self._client.models.embed_content(model=self.embed_model, contents=texts)
        return [list(e.values) for e in resp.embeddings]
