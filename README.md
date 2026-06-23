# Cortex

**A self-curating memory for a personal agent — belief revision over an episodic activity log.**

Most "give your agent a memory" projects save everything forever and retrieve by similarity.
Cortex is about the harder, more interesting problem: keeping a model of a person *honest over
time*. It watches a feed of your digital activity, distills typed **beliefs** about you, and
then curates them — reinforcing what recurs, **reconciling contradictions instead of
overwriting them**, and **forgetting by usefulness rather than by a clock**.

> Cortex adopts the *idea* behind a "proactive second-brain" agent, but not the common
> architecture for it. There is no fixed sensory/short/long tier split, no `importance / time`
> decay formula, and no graph database. The engineering centerpiece is the **memory
> lifecycle**, designed from scratch around evidence and contradiction.

---

## The model

Three layers, each with one job:

| Layer | What it is | Mutability |
|------|------------|------------|
| **Episodes** | Atomic observations normalized from the activity feed | Immutable, append-only (ground truth + provenance) |
| **Beliefs** | Typed assertions about the user (`preference` · `fact` · `goal` · `relationship` · `transient_state`) | Derived, reconciled over time |
| **Belief events** | Append-only audit of every lifecycle transition | The inspector replays these |

### Reconciliation — the heart of it

A freshly distilled candidate belief is never blindly written. It is reconciled against what
is already known, driven by **evidence and contradiction**, not a timer:

- **reinforce** — corroborating evidence raises confidence, counts the corroboration, refreshes recency.
- **supersede** — a contradicting *fact* that was simply wrong: the old belief is archived and linked to its replacement (`superseded_by`).
- **branch** — a contradicting *preference/goal/state* that has **changed over time**: the old belief is kept as history (validity window closed, demoted to dormant) while the new one becomes current. *"Used to prefer tea → now prefers coffee."*
- **consolidate** — near-duplicate beliefs collapse into one, unioning their provenance.
- **form** — nothing related: a brand-new belief.

Every outcome writes a `belief_events` row, so any belief's whole history is auditable.

### Forgetting by utility, not age

Retention is a score, not a stopwatch:

```
retention = w_salience · salience
          + w_reinforcement · (corroboration, with diminishing returns)
          + w_recency · 0.5 ^ (days_since_last_access / half_life)
```

Beliefs are **demoted** through tiers `active → dormant → archived` and only **hard-pruned**
when they are archived **and** low-salience **and** never retrieved. High-salience beliefs are
structurally safe from pruning.

The key departure from time-based decay: **retrieval feeds back into retention**. Reading (or
re-corroborating) a belief refreshes its `last_accessed_at`, so a belief that keeps proving
useful never cools off — *use it or lose it*. The `use_it_or_lose_it` eval demonstrates two
identically-trivial facts diverging purely because one was used.

---

## Architecture

```
activity feed ──▶ ingestion ──▶ Episodes (SQLite, immutable)
                                   │
                                   ▼
                         distiller (LLM) ──▶ candidate beliefs
                                   │
                                   ▼
                         reconciler ──▶ reinforce / supersede / branch / consolidate / form
                                   │           (writes belief_events audit)
                                   ▼
                         Beliefs (tiered) ◀──▶ retention (forgetting)  ◀── retrieval (feedback)
                                   │
                                   ▼
                         inspector / API / CLI / proactivity
```

- **Storage:** one SQLite file — `episodes`, `beliefs`, `belief_episodes` (provenance),
  `belief_events` (audit), `links` (relations, instead of a graph DB), `vectors` (embeddings).
  Fully inspectable; brute-force cosine search is plenty for a personal memory.
- **LLM seam:** a tiny `LLMClient` protocol (`complete` / `extract_structured` / `embed`). The
  lifecycle logic never imports a vendor SDK.
  - Providers (swappable via `CORTEX_LLM_PROVIDER`): **`vertex`** (Gemini, default) · `qwen`
    (Alibaba Qwen Cloud, OpenAI-compatible) · `openai` · `claude` · **`mock`** (deterministic,
    offline, used by all tests and evals).
  - Default embedding is a dependency-free deterministic **hashing embedding**, so retrieval
    and consolidation work offline with zero API calls. (It is purely lexical; a learned
    embedding model makes semantic matching far more robust — that's the one place to upgrade
    for production.)

---

## Quickstart

```bash
uv venv && uv pip install -e ".[dev]"

# Run the whole test suite (offline, deterministic — uses the mock provider)
.venv/bin/pytest

# Replay a scripted scenario and watch a preference change get reconciled
.venv/bin/python -m cortex.cli replay evals/scenarios/02_contradiction_branch.json --db /tmp/cortex.db
.venv/bin/python -m cortex.cli beliefs --db /tmp/cortex.db --all
# Inspect one belief's full lifecycle timeline:
.venv/bin/python -m cortex.cli inspect <belief_id> --db /tmp/cortex.db

# Run the lifecycle eval report
.venv/bin/python evals/run_evals.py
```

Example inspector output (the `branch` case):

```
Prefers tea
  type=preference tier=dormant confidence=0.70 salience=0.50
  superseded_by=bel_5f915657aaf2
  timeline:
    2026-06-20T08:00:00+00:00  formed        {"confidence": 0.7, "statement": "Prefers tea"}
    2026-06-20T08:00:00+00:00  contradicted  {"by": "bel_5f915657aaf2", "kind": "branch"}
```

### HTTP API

```bash
uvicorn cortex.api:app --reload
```

| Route | Purpose |
|-------|---------|
| `POST /ingest` | append activity events |
| `POST /learn` | distill recent episodes + reconcile |
| `POST /maintain` | consolidate + forget (retention sweep) |
| `GET /beliefs` | currently-held beliefs (`?all=true` for history) |
| `GET /beliefs/{id}/timeline` | **the inspector** — a belief's lifecycle |
| `POST /retrieve` | hybrid retrieval (and retention feedback) |

### Using a real model

```bash
export CORTEX_LLM_PROVIDER=qwen
export DASHSCOPE_API_KEY=...        # from https://home.qwencloud.com/api-keys
.venv/bin/python -m cortex.cli replay evals/scenarios/02_contradiction_branch.json --provider qwen
```

(`vertex` uses Application Default Credentials + `GOOGLE_CLOUD_PROJECT`; `openai` uses
`OPENAI_API_KEY`; `claude` uses `ANTHROPIC_API_KEY`.)

---

## Evals

`python evals/run_evals.py` replays scripted scenarios against a fresh in-memory Cortex and
checks the resulting belief state. Each scenario carries its own scripted model output, so the
suite is fully deterministic and offline.

| Scenario | Proves |
|----------|--------|
| `reinforcement` | corroboration merges into one belief, raises confidence + count |
| `contradiction_branch` | a changed preference branches into a timeline, old kept as history |
| `fact_supersede` | a corrected fact is archived and linked to its replacement |
| `stale_prune` | a trivial, unused belief drifts down the tiers and is pruned |
| `use_it_or_lose_it` | retrieval feedback spares a used belief while an unused twin is forgotten |

---

## What's intentionally out of scope (this build)

Real OS/browser/calendar connectors (a synthetic feed replayer stands in), a learned embedding
model, a rich proactive trigger engine (one demonstrative nudge rule ships in
`cortex/proactivity.py`), a web frontend, and authentication. The focus is the memory
lifecycle and its observability.
