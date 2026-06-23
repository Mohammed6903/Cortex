"""A deterministic, dependency-free hashing embedding.

This is the default embedder so Cortex's retrieval and consolidation work offline with
zero API calls. It is a hashed bag-of-words: identical text maps to an identical vector,
and texts sharing vocabulary land closer in cosine space than disjoint ones. Not as rich
as a learned model, but deterministic and good enough to drive (and test) the lifecycle.
"""

from __future__ import annotations

import hashlib
import math
import re

from .base import EMBED_DIM

_TOKEN = re.compile(r"[a-z0-9]+")


def _tokens(text: str) -> list[str]:
    return _TOKEN.findall(text.lower())


def hashing_embedding(text: str, dim: int = EMBED_DIM) -> list[float]:
    vec = [0.0] * dim
    for tok in _tokens(text):
        h = hashlib.sha1(tok.encode("utf-8")).digest()
        bucket = int.from_bytes(h[:4], "big") % dim
        sign = 1.0 if h[4] & 1 else -1.0
        vec[bucket] += sign
    norm = math.sqrt(sum(x * x for x in vec))
    if norm == 0.0:
        return vec
    return [x / norm for x in vec]
