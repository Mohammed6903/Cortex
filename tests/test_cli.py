import json
import re

from typer.testing import CliRunner

from cortex.cli import app

runner = CliRunner()

SCENARIO = {
    "name": "demo",
    "now": "2026-06-23T10:00:00+00:00",
    "events": [
        {"source": "editor", "kind": "open", "payload": {"lang": "python"}, "occurred_at": "2026-06-23T09:00:00+00:00"}
    ],
    "llm_structured": [
        {"beliefs": [{"type": "preference", "statement": "Prefers Python", "confidence": 0.8, "salience": 0.7, "source_episode_ids": []}]}
    ],
}


def _write(tmp_path):
    p = tmp_path / "scenario.json"
    p.write_text(json.dumps(SCENARIO))
    return str(p)


def test_replay_learns_and_reports(tmp_path):
    db = str(tmp_path / "c.db")
    scenario = _write(tmp_path)
    res = runner.invoke(app, ["replay", scenario, "--db", db, "--provider", "mock"])
    assert res.exit_code == 0, res.output
    assert "Prefers Python" in res.output


def test_beliefs_then_inspect_shows_timeline(tmp_path):
    db = str(tmp_path / "c.db")
    scenario = _write(tmp_path)
    runner.invoke(app, ["replay", scenario, "--db", db, "--provider", "mock"])

    listing = runner.invoke(app, ["beliefs", "--db", db, "--json"])
    assert listing.exit_code == 0, listing.output
    beliefs = json.loads(listing.output)
    bid = beliefs[0]["id"]

    inspected = runner.invoke(app, ["inspect", bid, "--db", db])
    assert inspected.exit_code == 0, inspected.output
    assert "formed" in inspected.output
