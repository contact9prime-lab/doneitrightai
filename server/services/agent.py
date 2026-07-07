"""Autopilot — the agentic model-building pipeline.

Give it a goal in plain language ("build a sentiment classifier for movie
reviews") and it runs the whole loop a human would:

1. **Understand** the goal → pick a task type and search queries.
2. **Search** public datasets on the Hugging Face Hub.
3. **Import** the most promising candidate (falls back to the next one if an
   import fails or the data doesn't fit the task).
4. **Analyze** the columns → map text/label columns, sanity-check the fit.
5. **Configure** a training job → base model + hyperparameters.
6. **Train** → launches a normal TrainForge job and watches it to completion,
   so the finished model lands in the registry like any manual run.

Planning is two-tier:

- **Heuristic planner (default)** — keyword rules, zero external calls, works
  fully offline. This is what makes Autopilot work out of the box.
- **LLM planner (optional)** — if ``ANTHROPIC_API_KEY`` is set, Claude picks
  the task, search queries, and the best dataset candidate instead. Model is
  overridable via ``TRAINFORGE_LLM_MODEL`` (default ``claude-sonnet-5``).

Every step is appended to the run's ``steps`` JSON in real time; the UI polls
and renders them as a live activity feed.

Autopilot never *replaces* manual mode — it produces ordinary datasets and
jobs you can inspect, rerun, or tweak by hand afterwards.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
import traceback
from typing import Any

import requests

from .. import db
from . import ingest, runner

# How long we're willing to wait, in seconds.
_IMPORT_TIMEOUT = 15 * 60
_TRAIN_TIMEOUT = 6 * 60 * 60
_POLL = 3

# Rows to import for autopilot runs — enough signal to train something real,
# small enough to finish while you watch. Users can override per run.
_DEFAULT_MAX_ROWS = 5000

_STOPWORDS = set("""a an and are as at be build builds building by can could
create do for from give has have how i if in is it me model models my of on
or predict should smart something that the this to train training want we
what which will with would you your please need like data dataset""".split())


# --------------------------------------------------------------------------
# Public API
# --------------------------------------------------------------------------

def start(goal: str, max_rows: int | None) -> dict[str, Any]:
    """Create a run row and execute the pipeline in a background thread."""
    run_id = db.insert_agent_run(goal.strip())
    threading.Thread(target=_execute, args=(run_id, goal.strip(), max_rows),
                     daemon=True, name=f"autopilot-{run_id}").start()
    return db.get_agent_run(run_id)


def llm_available() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


# --------------------------------------------------------------------------
# Pipeline
# --------------------------------------------------------------------------

def _execute(run_id: int, goal: str, max_rows: int | None) -> None:
    steps: list[dict[str, Any]] = []

    def step(title: str, detail: str = "", status: str = "done") -> None:
        """Append a step and persist immediately so the UI updates live."""
        steps.append({"time": time.time(), "title": title,
                      "detail": detail, "status": status})
        db.update_agent_run(run_id, steps=steps)

    try:
        # -- 1. understand the goal ------------------------------------
        plan = _plan(goal)
        planner = "Claude" if plan.get("_llm") else "built-in heuristics"
        step("Understood goal",
             f"task: {plan['task']} · planner: {planner} · "
             f"search queries: {', '.join(plan['queries'])}")

        # -- 2. search public data --------------------------------------
        candidates = _search(plan["queries"])
        if not candidates:
            raise RuntimeError(
                "No public datasets found for this goal. Try rephrasing, or "
                "import a dataset manually and train from the Train tab.")
        step("Searched public data",
             f"{len(candidates)} candidate datasets on the Hugging Face Hub; "
             f"top: {', '.join(c['repo_id'] for c in candidates[:5])}")

        if plan.get("_llm"):
            candidates = _llm_rank_candidates(goal, plan["task"], candidates) or candidates

        # -- 3+4. import candidates until one fits the task --------------
        dataset, fit, rejected = _import_first_fit(
            plan["task"], candidates, max_rows or _DEFAULT_MAX_ROWS, step)
        if dataset is None:
            raise RuntimeError(
                "None of the candidate datasets fit the task "
                f"({'; '.join(rejected[:4])}). Try a more specific goal.")
        db.update_agent_run(run_id, dataset_id=dataset["id"])
        step("Analyzed dataset",
             f"'{dataset['name']}' ({dataset['num_rows']} rows) — " + fit["summary"])

        # -- 5. configure the job ----------------------------------------
        hyperparams = dict(fit["hyperparams"])
        base_model = fit["base_model"]
        step("Configured training",
             f"task: {plan['task']} · base model: {base_model or 'n/a'} · "
             f"hyperparameters: {json.dumps(hyperparams)}")

        # -- 6. train ------------------------------------------------------
        job = runner.create_and_launch(
            name=_job_name(goal), dataset_id=dataset["id"],
            task=plan["task"], base_model=base_model, hyperparams=hyperparams)
        db.update_agent_run(run_id, job_id=job["id"])
        step("Launched training", f"job #{job['id']} '{job['name']}'",
             status="running")

        final = _wait_for_job(job["id"])
        steps[-1]["status"] = "done"
        if final["status"] != "succeeded":
            raise RuntimeError(
                f"Training job #{job['id']} {final['status']}: "
                f"{final.get('error') or 'see the job log'}")

        step("Model ready",
             f"metrics: {json.dumps(final.get('metrics') or {})} — "
             "registered in Models; publish it to Hugging Face from there.")
        db.update_agent_run(run_id, status="succeeded", finished_at=time.time())

    except Exception as exc:
        traceback.print_exc()
        step("Failed", str(exc)[:2000], status="failed")
        db.update_agent_run(run_id, status="failed", error=str(exc)[:2000],
                            finished_at=time.time())


# --------------------------------------------------------------------------
# Planning (heuristic + optional LLM)
# --------------------------------------------------------------------------

def _plan(goal: str) -> dict[str, Any]:
    """Decide task type + search queries. LLM if configured, else rules."""
    if llm_available():
        llm = _llm_plan(goal)
        if llm:
            return {**llm, "_llm": True}

    lower = goal.lower()
    # Order matters: generation phrasing wins over 'classify', numeric
    # prediction wins over generic 'predict'.
    if any(w in lower for w in ("fine-tune", "finetune", "chatbot", "chat bot",
                                "generate text", "language model", "llm",
                                "instruction", "assistant", "write like")):
        task = "causal-lm"
    elif any(w in lower for w in ("price", "value", "amount", "number",
                                  "regression", "estimate", "forecast",
                                  "how much", "how many")):
        task = "tabular-regression"
    elif any(w in lower for w in ("sentiment", "classify text", "text class",
                                  "review", "toxic", "spam", "intent",
                                  "emotion", "topic", "news")):
        task = "text-classification"
    elif any(w in lower for w in ("csv", "tabular", "spreadsheet", "excel",
                                  "columns", "table")):
        task = "tabular-classification"
    else:
        task = "text-classification"  # most common ask; label check guards fit

    keywords = [w for w in re.findall(r"[a-z0-9][a-z0-9-]+", lower)
                if w not in _STOPWORDS][:6]
    queries = []
    if keywords:
        queries.append(" ".join(keywords[:3]))
        if len(keywords) > 3:
            queries.append(" ".join(keywords[3:6]))
        queries.append(keywords[0])
    # Deduplicate, preserve order.
    queries = list(dict.fromkeys(q for q in queries if q)) or [lower[:50]]
    return {"task": task, "queries": queries, "_llm": False}


def _search(queries: list[str]) -> list[dict[str, Any]]:
    """Union of Hub search results across queries, deduped, download-ranked."""
    seen: dict[str, dict[str, Any]] = {}
    for q in queries:
        try:
            for card in ingest.search_hub(q, limit=10):
                seen.setdefault(card["repo_id"], card)
        except Exception:
            continue  # one bad query shouldn't sink the run
    return sorted(seen.values(),
                  key=lambda c: c.get("downloads") or 0, reverse=True)[:10]


def _import_first_fit(task: str, candidates: list[dict[str, Any]],
                      max_rows: int, step) -> tuple[dict | None, dict | None, list[str]]:
    """Try candidates in order: import → check the data actually fits the
    task. Returns (dataset, fit_config, rejection_reasons)."""
    rejected: list[str] = []
    for candidate in candidates[:4]:  # cap the damage of a bad search
        repo = candidate["repo_id"]
        step("Importing dataset", f"{repo} (up to {max_rows} rows)…",
             status="running")
        try:
            row = ingest.import_from_hub(repo, None, "train", max_rows, None)
            dataset = _wait_for_dataset(row["id"])
        except Exception as exc:
            rejected.append(f"{repo}: import failed ({exc})")
            continue
        if dataset["status"] != "ready":
            rejected.append(f"{repo}: {dataset.get('error') or 'import failed'}")
            continue

        fit = _check_fit(task, dataset)
        if fit is None:
            rejected.append(f"{repo}: columns don't fit task '{task}'")
            db.delete_dataset(dataset["id"])  # don't litter the workspace
            continue
        return dataset, fit, rejected
    return None, None, rejected


def _check_fit(task: str, dataset: dict[str, Any]) -> dict[str, Any] | None:
    """Validate the imported data against the task and derive the training
    configuration (columns, base model, hyperparameters)."""
    df = ingest.load_dataframe(dataset)
    text_col = ingest.guess_text_column(df)
    label_col = ingest.guess_label_column(df)

    if task == "text-classification":
        if not text_col or not label_col:
            return None
        n_labels = df[label_col].nunique(dropna=True)
        if not 2 <= n_labels <= 100:
            return None
        return {
            "base_model": "distilbert-base-uncased",
            "hyperparams": {"text_column": text_col, "label_column": label_col,
                            "epochs": 2},
            "summary": f"text='{text_col}', label='{label_col}' "
                       f"({n_labels} classes)",
        }
    if task == "causal-lm":
        if not text_col:
            return None
        return {
            "base_model": "TinyLlama/TinyLlama-1.1B-Chat-v1.0",
            "hyperparams": {"text_column": text_col},
            "summary": f"training text from column '{text_col}'",
        }
    # tabular-*: need a label plus at least one other usable feature column
    if not label_col or len(df.columns) < 2:
        return None
    if task == "tabular-regression":
        import pandas as pd
        if not pd.api.types.is_numeric_dtype(df[label_col]):
            return None
    return {
        "base_model": None,
        "hyperparams": {"label_column": label_col},
        "summary": f"label='{label_col}', {len(df.columns) - 1} feature columns",
    }


# --------------------------------------------------------------------------
# Optional Claude-powered planning
# --------------------------------------------------------------------------

def _llm(prompt: str, max_tokens: int = 500) -> str | None:
    """Minimal Anthropic Messages API call (no SDK dependency).
    Returns None on any failure so callers fall back to heuristics."""
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        return None
    try:
        resp = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={"x-api-key": key, "anthropic-version": "2023-06-01",
                     "content-type": "application/json"},
            json={"model": os.environ.get("TRAINFORGE_LLM_MODEL",
                                          "claude-sonnet-5"),
                  "max_tokens": max_tokens,
                  "messages": [{"role": "user", "content": prompt}]},
            timeout=60)
        resp.raise_for_status()
        return "".join(b.get("text", "") for b in resp.json()["content"])
    except Exception:
        traceback.print_exc()
        return None


def _llm_json(prompt: str) -> dict | list | None:
    """LLM call that must return JSON; extracts the first JSON block."""
    text = _llm(prompt)
    if not text:
        return None
    match = re.search(r"\{.*\}|\[.*\]", text, re.DOTALL)
    if not match:
        return None
    try:
        return json.loads(match.group(0))
    except ValueError:
        return None


def _llm_plan(goal: str) -> dict[str, Any] | None:
    data = _llm_json(f"""You are the planner of an ML training platform.
The user's goal: {goal!r}

Available tasks: text-classification, causal-lm, tabular-classification,
tabular-regression.

Reply with ONLY a JSON object:
{{"task": "<one of the tasks>", "queries": ["<2-3 short Hugging Face dataset
search queries likely to find public datasets for this goal>"]}}""")
    if (isinstance(data, dict) and data.get("task") in
            ("text-classification", "causal-lm",
             "tabular-classification", "tabular-regression")
            and isinstance(data.get("queries"), list) and data["queries"]):
        return {"task": data["task"],
                "queries": [str(q)[:80] for q in data["queries"][:4]]}
    return None


def _llm_rank_candidates(goal: str, task: str,
                         candidates: list[dict]) -> list[dict] | None:
    """Ask Claude to reorder the candidate datasets, best first."""
    listing = "\n".join(
        f"- {c['repo_id']} (downloads: {c.get('downloads')}, "
        f"tags: {', '.join(c.get('tags') or [])})" for c in candidates)
    data = _llm_json(f"""Goal: {goal!r} (task: {task})
Candidate public datasets:
{listing}

Reply with ONLY a JSON array of repo ids, best-fit first, excluding any that
clearly don't match the goal.""")
    if not isinstance(data, list) or not data:
        return None
    by_id = {c["repo_id"]: c for c in candidates}
    ranked = [by_id[r] for r in data if isinstance(r, str) and r in by_id]
    # Keep anything the LLM dropped at the tail — it's a ranking, not a veto.
    ranked += [c for c in candidates if c not in ranked]
    return ranked or None


# --------------------------------------------------------------------------
# Waiting helpers
# --------------------------------------------------------------------------

def _wait_for_dataset(dataset_id: int) -> dict[str, Any]:
    deadline = time.time() + _IMPORT_TIMEOUT
    while time.time() < deadline:
        dataset = db.get_dataset(dataset_id)
        if dataset and dataset["status"] in ("ready", "failed"):
            return dataset
        time.sleep(_POLL)
    raise TimeoutError("Dataset import timed out.")


def _wait_for_job(job_id: int) -> dict[str, Any]:
    deadline = time.time() + _TRAIN_TIMEOUT
    while time.time() < deadline:
        job = runner.refresh_status(db.get_job(job_id))
        if job and job["status"] in ("succeeded", "failed", "stopped"):
            return job
        time.sleep(_POLL)
    raise TimeoutError("Training job timed out.")


def _job_name(goal: str) -> str:
    slug = re.sub(r"\s+", " ", goal).strip()
    return (slug[:60] + "…") if len(slug) > 60 else slug or "autopilot job"
