import math

from cortex.llm.mock import MockLLM


def _cosine(a, b):
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    return dot / (na * nb) if na and nb else 0.0


def test_complete_returns_scripted_responses_in_order():
    llm = MockLLM(completions=["first", "second"])
    assert llm.complete("anything") == "first"
    assert llm.complete("anything") == "second"


def test_extract_structured_returns_scripted_objects_in_order():
    payloads = [{"beliefs": [{"statement": "likes python"}]}, {"beliefs": []}]
    llm = MockLLM(structured=payloads)
    assert llm.extract_structured("prompt", schema={}) == payloads[0]
    assert llm.extract_structured("prompt", schema={}) == payloads[1]


def test_embed_is_deterministic():
    llm = MockLLM()
    v1 = llm.embed(["prefers python over java"])[0]
    v2 = llm.embed(["prefers python over java"])[0]
    assert v1 == v2


def test_embed_vectors_are_normalized():
    llm = MockLLM()
    v = llm.embed(["some text here"])[0]
    norm = math.sqrt(sum(x * x for x in v))
    assert abs(norm - 1.0) < 1e-6


def test_embed_shared_vocabulary_is_more_similar_than_disjoint():
    llm = MockLLM()
    base = llm.embed(["prefers python over java for backend"])[0]
    near = llm.embed(["prefers python for backend work"])[0]
    far = llm.embed(["allergic to peanuts and shellfish"])[0]
    assert _cosine(base, near) > _cosine(base, far)
