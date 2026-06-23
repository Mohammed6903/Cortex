"""Offline eval harness for the memory lifecycle.

Each scenario in ``scenarios/`` is a scripted activity stream plus the model output it should
produce (so everything runs deterministically on the mock provider) and a list of expected
outcomes. The harness replays each scenario against a fresh in-memory Cortex and checks the
final belief state. Run directly to print a report and get a non-zero exit on any failure:

    python evals/run_evals.py
"""

from __future__ import annotations

import glob
import json
import os
from datetime import datetime
from typing import Any, Optional

from cortex.config import Config
from cortex.engine import Cortex
from cortex.llm.mock import MockLLM
from cortex.models import Tier
from cortex.store import beliefs as belief_store
from cortex.store.db import connect, init_schema

SCENARIO_DIR = os.path.join(os.path.dirname(__file__), "scenarios")


def _dt(value: Optional[str]) -> Optional[datetime]:
    return datetime.fromisoformat(value) if value else None


def _find(engine: Cortex, statement: str):
    return [b for b in engine.all_beliefs() if b.statement == statement]


def _check(engine: Cortex, check: dict[str, Any]) -> tuple[str, bool]:
    kind = check["kind"]
    if kind == "belief_present":
        matches = _find(engine, check["statement"])
        ok = bool(matches)
        if ok and "tier" in check:
            ok = any(b.tier is Tier(check["tier"]) for b in matches)
        return f"present[{check['statement']}{'/' + check['tier'] if 'tier' in check else ''}]", ok
    if kind == "belief_absent":
        return f"absent[{check['statement']}]", not _find(engine, check["statement"])
    if kind == "belief_tier":
        matches = _find(engine, check["statement"])
        return f"tier[{check['statement']}={check['tier']}]", any(
            b.tier is Tier(check["tier"]) for b in matches
        )
    if kind == "reinforced":
        matches = _find(engine, check["statement"])
        return f"reinforced[{check['statement']}>={check['min_count']}]", any(
            b.reinforcement_count >= check["min_count"] for b in matches
        )
    if kind == "has_successor":
        matches = _find(engine, check["statement"])
        return f"has_successor[{check['statement']}]", any(b.superseded_by for b in matches)
    if kind == "event_present":
        matches = _find(engine, check["statement"])
        types = {
            e.event_type.value for b in matches for e in engine.timeline(b.id)
        }
        return f"event[{check['statement']}:{check['event_type']}]", check["event_type"] in types
    if kind == "count_active":
        return f"count_active=={check['value']}", len(engine.snapshot()) == check["value"]
    return f"unknown[{kind}]", False


def run_scenario(path: str) -> dict[str, Any]:
    with open(path, "r", encoding="utf-8") as fh:
        scenario = json.load(fh)

    conn = connect(":memory:")
    init_schema(conn)
    engine = Cortex(conn, MockLLM(structured=list(scenario.get("llm_structured", []))), Config())

    engine.ingest(scenario["events"])
    engine.learn(now=_dt(scenario.get("learn_now")))

    if "retrieve" in scenario:
        r = scenario["retrieve"]
        engine.retrieve(r["query"], k=r.get("k", 5), now=_dt(r.get("now")))

    if scenario.get("maintain_now") or scenario.get("maintain_rounds"):
        for _ in range(scenario.get("maintain_rounds", 1)):
            engine.maintain(now=_dt(scenario.get("maintain_now")))

    checks = [_check(engine, c) for c in scenario["expected"]]
    return {
        "name": scenario["name"],
        "description": scenario.get("description", ""),
        "checks": [{"desc": d, "ok": ok} for d, ok in checks],
        "passed": all(ok for _, ok in checks),
    }


def run(scenario_dir: str = SCENARIO_DIR) -> list[dict[str, Any]]:
    paths = sorted(glob.glob(os.path.join(scenario_dir, "*.json")))
    return [run_scenario(p) for p in paths]


def to_markdown(results: list[dict[str, Any]]) -> str:
    total = len(results)
    passed = sum(1 for r in results if r["passed"])
    lines = ["# Cortex lifecycle eval report", "", f"**{passed}/{total} scenarios passed.**", ""]
    for r in results:
        mark = "✅" if r["passed"] else "❌"
        lines.append(f"## {mark} {r['name']}")
        lines.append("")
        lines.append(f"_{r['description']}_")
        lines.append("")
        for c in r["checks"]:
            lines.append(f"- {'✅' if c['ok'] else '❌'} {c['desc']}")
        lines.append("")
    return "\n".join(lines)


def main() -> int:
    results = run()
    report = to_markdown(results)
    print(report)
    out_dir = os.path.join(os.path.dirname(__file__), "reports")
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "latest.md"), "w", encoding="utf-8") as fh:
        fh.write(report)
    return 0 if all(r["passed"] for r in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
