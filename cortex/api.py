"""FastAPI surface for Cortex.

The headline route is ``GET /beliefs/{id}/timeline`` — the memory *inspector* — which
replays a belief's entire lifecycle (formed → reinforced → contradicted → superseded →
demoted …). The rest of the API drives the same engine the CLI and evals use.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

import os

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .engine import Cortex
from .envfile import load_env_file
from .session import current_engine, get_session

# Load <repo>/.env before anything reads Config, so `uvicorn cortex.api:app` picks up
# CORTEX_LLM_PROVIDER / DASHSCOPE_API_KEY without a manual export.
load_env_file()

app = FastAPI(title="Cortex", description="A self-curating memory for a personal agent.")

# The web client (Next.js dev server) is a different origin, so the browser sends a CORS
# preflight (OPTIONS) before every POST. Without this it 405s and the UI sees "Failed to
# fetch". Allow the local dev origins; override with CORTEX_CORS_ORIGINS (comma-separated).
_default_origins = "http://localhost:3000,http://127.0.0.1:3000"
_cors_origins = [
    o.strip()
    for o in os.environ.get("CORTEX_CORS_ORIGINS", _default_origins).split(",")
    if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_engine() -> Cortex:
    """The active engine for the request.

    Bound to the disposable SCRATCH session (see :mod:`cortex.session`), never a real
    persisted store — so the UI's learn/maintain/retrieve/replay runs can never destroy
    live data. The scratch db is seeded with a default scenario on first use.
    """
    return current_engine()


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


class SessionResetBody(BaseModel):
    scenario: Optional[str] = None


# --- routes ---
@app.post("/ingest")
def ingest(body: IngestBody, engine: Cortex = Depends(get_engine)) -> dict[str, int]:
    episodes = engine.ingest(body.events)
    return {"ingested": len(episodes)}


@app.post("/learn")
def learn(body: LearnBody, engine: Cortex = Depends(get_engine)) -> dict[str, Any]:
    try:
        results = engine.learn(now=body.now)
    except AssertionError:
        # The mock chat client ran out of scripted responses: free-form distillation needs a
        # real provider. Tell the caller how to enable it instead of 500-ing.
        session = get_session()
        raise HTTPException(
            status_code=400,
            detail=(
                "Free-form learning needs a real LLM provider, but the session is running in "
                f"mock mode ({session.degrade_reason or 'CORTEX_LLM_PROVIDER=mock'}). Set "
                "CORTEX_LLM_PROVIDER=qwen and DASHSCOPE_API_KEY, restart the API, then reset "
                "the session. Canned scenarios still work in mock mode."
            ),
        )
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


# --- honesty / safety routes for the UI ---
@app.post("/session/reset")
def session_reset(body: SessionResetBody) -> dict[str, Any]:
    """Drop and recreate the scratch db, optionally re-seeding from a named scenario.

    A scratch session means the UI can run learn/maintain/retrieve/replay freely without
    ever touching a real store. ``scenario`` is a name from ``evals/scenarios/*.json``;
    omit it for an empty scratch. Returns ``{ok, beliefs, db}``.
    """
    from .session import available_scenarios

    try:
        return get_session().reset(body.scenario)
    except FileNotFoundError:
        raise HTTPException(
            status_code=404,
            detail=f"unknown scenario {body.scenario!r}; available: {available_scenarios()}",
        )


@app.get("/beliefs/{belief_id}/provenance")
def belief_provenance(
    belief_id: str, engine: Cortex = Depends(get_engine)
) -> list[dict[str, Any]]:
    """The immutable episodes a belief was distilled/corroborated from."""
    from .store import beliefs as belief_store
    from .store import episodes as episode_store

    if belief_store.get(engine.conn, belief_id) is None:
        raise HTTPException(status_code=404, detail="belief not found")

    out: list[dict[str, Any]] = []
    for ep_id in belief_store.provenance(engine.conn, belief_id):
        episode = episode_store.get(engine.conn, ep_id)
        if episode is not None:
            out.append(episode.model_dump(mode="json"))
    return out


@app.get("/stats")
def stats(engine: Cortex = Depends(get_engine)) -> dict[str, Any]:
    """Tier counts over all beliefs, for the Mind Monitor KPI strip.

    ``held`` is the active tier; PRUNED has no row and emits no event, so it is *not*
    reported here — the UI reconstructs prune tombstones by snapshot-diffing two
    ``/beliefs?all=true`` reads across a maintain run.
    """
    from .models import Tier

    counts = {Tier.active.value: 0, Tier.dormant.value: 0, Tier.archived.value: 0}
    for b in engine.all_beliefs():
        counts[b.tier.value] = counts.get(b.tier.value, 0) + 1
    session = get_session()
    return {
        "held": counts[Tier.active.value],
        "dormant": counts[Tier.dormant.value],
        "archived": counts[Tier.archived.value],
        "total": sum(counts.values()),
        "scenario": session.scenario,
        "provider": session.active_provider,
        "degraded": session.degraded,
    }


@app.get("/config")
def config() -> dict[str, Any]:
    """The retention weights, halflife, tier thresholds, and prune rule.

    Surfaced so the client never hardcodes the formula: its ESTIMATED retention must
    match the engine's, and the governing thresholds are shown inline in the UI.
    """
    cfg = get_session().config
    return {
        "weights": {
            "salience": cfg.w_salience,
            "reinforcement": cfg.w_reinforcement,
            "recency": cfg.w_recency,
        },
        "recency_halflife_days": cfg.recency_halflife_days,
        "thresholds": {
            "dormant_retention_max": cfg.dormant_retention_max,
            "archive_retention_max": cfg.archive_retention_max,
        },
        "prune": {
            "salience_max": cfg.prune_salience_max,
            "requires_tier": "archived",
            "requires_never_accessed": True,
        },
    }
