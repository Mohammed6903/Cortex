from cortex.config import Config


def test_defaults_when_env_is_empty():
    cfg = Config.from_env({})
    assert cfg.llm_provider == "vertex"
    assert cfg.db_path.endswith(".db") or cfg.db_path == ":memory:"
    # Retention thresholds have sane defaults in [0, 1].
    assert 0.0 <= cfg.prune_salience_max <= 1.0
    assert 0.0 <= cfg.dormant_retention_max <= 1.0


def test_env_overrides_provider_and_db():
    cfg = Config.from_env(
        {"CORTEX_LLM_PROVIDER": "qwen", "CORTEX_DB_PATH": "/tmp/x.db"}
    )
    assert cfg.llm_provider == "qwen"
    assert cfg.db_path == "/tmp/x.db"


def test_numeric_thresholds_parse_from_env():
    cfg = Config.from_env({"CORTEX_PRUNE_SALIENCE_MAX": "0.1"})
    assert cfg.prune_salience_max == 0.1
