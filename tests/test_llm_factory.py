import pytest

from cortex.config import Config
from cortex.llm.factory import build_llm
from cortex.llm.mock import MockLLM


def test_mock_provider_returns_mock():
    llm = build_llm(Config(llm_provider="mock"))
    assert isinstance(llm, MockLLM)


def test_unknown_provider_raises():
    with pytest.raises(ValueError):
        build_llm(Config(llm_provider="nonsense"))


def test_real_adapters_are_not_imported_until_selected():
    # Selecting mock must not require any vendor SDK to be installed.
    build_llm(Config(llm_provider="mock"))
