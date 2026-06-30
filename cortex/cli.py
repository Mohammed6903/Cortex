"""Command line for driving and inspecting Cortex.

    cortex replay <scenario.json>   # ingest a scripted activity stream, then learn + maintain
    cortex beliefs                  # show currently-held beliefs
    cortex inspect <belief_id>      # replay one belief's full lifecycle timeline
    cortex prune                    # run a maintenance sweep (consolidate + forget)

With ``--provider mock`` (the default for replay), the scenario's ``llm_structured`` list
supplies the model's responses, so demos run offline and reproduce exactly.
"""

from __future__ import annotations

import dataclasses
import json
from datetime import datetime
from typing import Optional

import typer

from .config import Config
from .engine import Cortex
from .envfile import load_env_file
from .ingestion import feed
from .llm.factory import build_llm
from .llm.mock import MockLLM
from .store import beliefs as belief_store
from .store.db import connect, init_schema

# Pick up <repo>/.env (provider/keys) for `cortex ...` invocations too.
load_env_file()

app = typer.Typer(add_completion=False, help="A self-curating memory for a personal agent.")


def _config(db: Optional[str], provider: Optional[str]) -> Config:
    base = Config.from_env()
    return dataclasses.replace(
        base,
        db_path=db or base.db_path,
        llm_provider=provider or base.llm_provider,
    )


def _engine(config: Config, scripted: Optional[list] = None) -> Cortex:
    conn = connect(config.db_path)
    init_schema(conn)
    if config.llm_provider == "mock":
        llm = MockLLM(structured=list(scripted or []))
    else:
        llm = build_llm(config)
    return Cortex(conn, llm, config)


@app.command()
def replay(
    scenario: str,
    db: str = typer.Option("cortex.db", help="SQLite database path."),
    provider: str = typer.Option("mock", help="LLM provider (mock|vertex|qwen|openai|claude)."),
) -> None:
    """Replay a scenario file: ingest its events, distill+reconcile, then run maintenance."""
    with open(scenario, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    config = _config(db, provider)
    engine = _engine(config, scripted=data.get("llm_structured"))

    episodes = engine.ingest(data["events"])
    now = datetime.fromisoformat(data["now"]) if data.get("now") else None
    results = engine.learn(now=now)
    engine.maintain(now=now)

    typer.echo(f"Ingested {len(episodes)} episode(s); reconciled {len(results)} candidate(s).")
    for r in results:
        typer.echo(f"  - {r.action.value}: {r.belief_id}")
    typer.echo("\nCurrent beliefs:")
    for b in engine.snapshot():
        typer.echo(f"  [{b.type.value}] {b.statement}  (conf={b.confidence:.2f}, sal={b.salience:.2f})")


@app.command()
def beliefs(
    db: str = typer.Option("cortex.db", help="SQLite database path."),
    all: bool = typer.Option(False, "--all", help="Include dormant/archived beliefs."),
    json_out: bool = typer.Option(False, "--json", help="Emit JSON."),
) -> None:
    """List beliefs Cortex currently holds."""
    engine = _engine(_config(db, "mock"))
    items = engine.all_beliefs() if all else engine.snapshot()
    if json_out:
        typer.echo(json.dumps([b.model_dump(mode="json") for b in items], default=str))
        return
    for b in items:
        typer.echo(f"{b.id}  [{b.type.value}/{b.tier.value}] {b.statement}")


@app.command()
def inspect(
    belief_id: str,
    db: str = typer.Option("cortex.db", help="SQLite database path."),
) -> None:
    """Replay a belief's lifecycle: how it formed, was reinforced, contradicted, or faded."""
    engine = _engine(_config(db, "mock"))
    belief = belief_store.get(engine.conn, belief_id)
    if belief is None:
        typer.echo(f"No belief with id {belief_id!r}.")
        raise typer.Exit(code=1)

    typer.echo(f"{belief.statement}")
    typer.echo(f"  type={belief.type.value} tier={belief.tier.value} "
               f"confidence={belief.confidence:.2f} salience={belief.salience:.2f}")
    if belief.superseded_by:
        typer.echo(f"  superseded_by={belief.superseded_by}")
    typer.echo("  timeline:")
    for e in engine.timeline(belief_id):
        typer.echo(f"    {e.at.isoformat()}  {e.event_type.value}  {json.dumps(e.detail)}")


@app.command()
def prune(
    db: str = typer.Option("cortex.db", help="SQLite database path."),
    now: Optional[str] = typer.Option(None, help="ISO timestamp to evaluate retention at."),
) -> None:
    """Run a maintenance sweep: consolidate duplicates and forget low-utility beliefs."""
    engine = _engine(_config(db, "mock"))
    moment = datetime.fromisoformat(now) if now else None
    report = engine.maintain(now=moment)
    typer.echo(
        f"merged={len(report['merged'])} "
        f"demoted={len(report['demoted'])} "
        f"pruned={len(report['pruned'])}"
    )


if __name__ == "__main__":
    app()
