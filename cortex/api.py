"""FastAPI surface for Cortex.

The headline route is ``GET /beliefs/{id}/timeline`` — the memory *inspector* — which
replays a belief's entire lifecycle (formed → reinforced → contradicted → superseded →
demoted …). The rest of the API drives the same engine the CLI and evals use.
"""

from __future__ import annotations

from datetime import datetime
from functools import lru_cache
from typing import Any, Optional

from fastapi import Depends, FastAPI, HTTPException
from pydantic import BaseModel

from .config import Config
from .engine import Cortex
from .llm.factory import build_llm
from .store.db import connect, init_schema

app = FastAPI(title="Cortex", description="A self-curating memory for a personal agent.")


@lru_cache(maxsize=1)
def get_engine() -> Cortex:
    """The process-wide engine, backed by the configured database and LLM provider."""
    config = Config.from_env()
    conn = connect(config.db_path)
    init_schema(conn)
    return Cortex(conn, build_llm(config), config)


# --- request bodies ---
class IngestBody(BaseModel):
    events: list[dict[str, Any]]


class LearnBody(BaseModel):
    now: Optional[datetime] = None


class RetrieveBody(BaseModel):
    query: str
    k: int = 5
    now: Optional[datetime] = None


class MaintainBody(BaseModel):
    now: Optional[datetime] = None


# --- routes ---
@app.post("/ingest")
def ingest(body: IngestBody, engine: Cortex = Depends(get_engine)) -> dict[str, int]:
    episodes = engine.ingest(body.events)
    return {"ingested": len(episodes)}


@app.post("/learn")
def learn(body: LearnBody, engine: Cortex = Depends(get_engine)) -> dict[str, Any]:
    results = engine.learn(now=body.now)
    return {
        "results": [
            {"action": r.action.value, "belief_id": r.belief_id, "prior_id": r.prior_id}
            for r in results
        ]
    }


@app.post("/maintain")
def maintain(body: MaintainBody, engine: Cortex = Depends(get_engine)) -> dict[str, Any]:
    return engine.maintain(now=body.now)


@app.get("/beliefs")
def list_beliefs(
    all: bool = False, engine: Cortex = Depends(get_engine)
) -> list[dict[str, Any]]:
    beliefs = engine.all_beliefs() if all else engine.snapshot()
    return [b.model_dump(mode="json") for b in beliefs]


@app.get("/beliefs/{belief_id}")
def get_belief(belief_id: str, engine: Cortex = Depends(get_engine)) -> dict[str, Any]:
    from .store import beliefs as belief_store

    belief = belief_store.get(engine.conn, belief_id)
    if belief is None:
        raise HTTPException(status_code=404, detail="belief not found")
    return belief.model_dump(mode="json")


@app.get("/beliefs/{belief_id}/timeline")
def belief_timeline(
    belief_id: str, engine: Cortex = Depends(get_engine)
) -> list[dict[str, Any]]:
    from .store import beliefs as belief_store

    if belief_store.get(engine.conn, belief_id) is None:
        raise HTTPException(status_code=404, detail="belief not found")
    return [e.model_dump(mode="json") for e in engine.timeline(belief_id)]


@app.post("/retrieve")
def retrieve(body: RetrieveBody, engine: Cortex = Depends(get_engine)) -> list[dict[str, Any]]:
    hits = engine.retrieve(body.query, k=body.k, now=body.now)
    return [b.model_dump(mode="json") for b in hits]
