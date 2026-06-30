"""Load a repo-root ``.env`` for the server/CLI entrypoints.

``Config.from_env`` reads ``os.environ`` — but nothing populates it from a ``.env`` file by
default, so a key sitting in ``.env`` would be silently ignored. Entrypoints call
:func:`load_env_file` at startup so ``CORTEX_LLM_PROVIDER`` / ``DASHSCOPE_API_KEY`` etc. take
effect with a plain ``uvicorn cortex.api:app``. Explicit shell exports always win
(``override=False``), and a missing python-dotenv or missing ``.env`` is a silent no-op.
"""

from __future__ import annotations

from pathlib import Path


def load_env_file() -> bool:
    """Load ``<repo>/.env`` into the environment. Returns True if a file was loaded."""
    try:
        from dotenv import load_dotenv
    except ImportError:
        return False
    env_path = Path(__file__).resolve().parent.parent / ".env"
    if not env_path.exists():
        return False
    load_dotenv(env_path, override=False)
    return True
