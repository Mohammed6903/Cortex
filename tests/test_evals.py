import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from evals.run_evals import run


def test_all_lifecycle_scenarios_pass():
    results = run()
    assert results, "no scenarios found"
    failures = [r["name"] for r in results if not r["passed"]]
    assert not failures, f"failing scenarios: {failures}\n" + str(results)
