from datetime import datetime, timezone

from cortex.config import Config
from cortex.lifecycle.distiller import CandidateBelief, distill
from cortex.llm.mock import MockLLM
from cortex.models import BeliefType, Episode


def _dt(s: str) -> datetime:
    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)


def _episodes():
    return [
        Episode(
            id="e1",
            source="editor",
            kind="file_opened",
            payload={"path": "main.py", "lang": "python"},
            occurred_at=_dt("2026-06-23T09:00:00"),
            ingested_at=_dt("2026-06-23T09:00:00"),
        ),
        Episode(
            id="e2",
            source="browser",
            kind="visit",
            payload={"url": "docs.python.org"},
            occurred_at=_dt("2026-06-23T09:05:00"),
            ingested_at=_dt("2026-06-23T09:05:00"),
        ),
    ]


def test_distill_maps_structured_output_to_candidates():
    llm = MockLLM(
        structured=[
            {
                "beliefs": [
                    {
                        "type": "preference",
                        "statement": "Prefers Python",
                        "confidence": 0.8,
                        "salience": 0.7,
                        "source_episode_ids": ["e1", "e2"],
                    }
                ]
            }
        ]
    )
    cands = distill(llm, _episodes(), Config())
    assert len(cands) == 1
    c = cands[0]
    assert isinstance(c, CandidateBelief)
    assert c.type is BeliefType.preference
    assert c.statement == "Prefers Python"
    assert c.source_episode_ids == ["e1", "e2"]


def test_distill_drops_unknown_provenance_ids():
    llm = MockLLM(
        structured=[
            {
                "beliefs": [
                    {
                        "type": "fact",
                        "statement": "x",
                        "confidence": 0.9,
                        "salience": 0.5,
                        "source_episode_ids": ["e1", "ghost"],
                    }
                ]
            }
        ]
    )
    cands = distill(llm, _episodes(), Config())
    assert cands[0].source_episode_ids == ["e1"]


def test_distill_falls_back_to_all_episodes_when_no_valid_provenance():
    llm = MockLLM(
        structured=[
            {
                "beliefs": [
                    {
                        "type": "fact",
                        "statement": "x",
                        "confidence": 0.9,
                        "salience": 0.5,
                        "source_episode_ids": ["ghost"],
                    }
                ]
            }
        ]
    )
    cands = distill(llm, _episodes(), Config())
    assert set(cands[0].source_episode_ids) == {"e1", "e2"}


def test_distill_prompt_includes_episode_content():
    llm = MockLLM(structured=[{"beliefs": []}])
    distill(llm, _episodes(), Config())
    method, prompt = llm.calls[-1]
    assert method == "extract_structured"
    assert "main.py" in prompt and "docs.python.org" in prompt


def test_distill_skips_llm_when_no_episodes():
    llm = MockLLM(structured=[])
    assert distill(llm, [], Config()) == []
