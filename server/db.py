"""SQLite persistence layer.

TrainForge deliberately uses plain SQLite (stdlib ``sqlite3``) instead of an
ORM: there are only three tables, the platform is single-node by design, and
zero extra dependencies means one less thing that can break on install.

Concurrency model
-----------------
Both the API server *and* every training worker process open this same
database file. WAL journaling allows concurrent readers with a single writer,
and every write here is a short autocommit statement, so contention is
negligible. ``busy_timeout`` makes rare write collisions wait instead of
erroring.

Tables
------
``datasets``    — data imported from public sources (HF Hub, URLs) or uploads.
``jobs``        — training runs: hyperparameters, live status, metrics.
``models``      — finished artifacts registered from successful jobs,
                  with optional Hugging Face publication info.
``agent_runs``  — Autopilot runs with their live step feeds.

The ``REFERENCES`` clauses document provenance but are deliberately NOT
enforced (no ``PRAGMA foreign_keys``): rows own copies of what they need
(models copy their artifact out of the job directory), so datasets, jobs,
and models can each be deleted in any order without cascading breakage.

JSON columns (``columns``, ``hyperparams``, ``metrics``…) are stored as TEXT
and (de)serialized by the helpers below, keeping rows human-inspectable with
any SQLite browser.
"""

from __future__ import annotations

import json
import sqlite3
import time
from typing import Any

from . import config

_SCHEMA = """
CREATE TABLE IF NOT EXISTS datasets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    source_type TEXT NOT NULL,           -- 'huggingface' | 'url' | 'upload'
    source_ref  TEXT NOT NULL,           -- repo id, URL, or original filename
    path        TEXT NOT NULL,           -- directory under data/datasets/
    format      TEXT NOT NULL DEFAULT 'parquet',
    num_rows    INTEGER,
    size_bytes  INTEGER,
    columns     TEXT,                    -- JSON: [{name, dtype, n_unique, samples}]
    status      TEXT NOT NULL DEFAULT 'ready',  -- 'importing' | 'ready' | 'failed'
    error       TEXT,
    created_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    dataset_id  INTEGER NOT NULL REFERENCES datasets(id),
    task        TEXT NOT NULL,           -- 'tabular-classification' | 'tabular-regression'
                                         -- | 'text-classification' | 'causal-lm'
    base_model  TEXT,                    -- HF model id for deep-learning tasks
    hyperparams TEXT NOT NULL,           -- JSON dict, task-specific
    status      TEXT NOT NULL DEFAULT 'queued',
                                         -- 'queued' | 'running' | 'succeeded'
                                         -- | 'failed' | 'stopped'
    pid         INTEGER,                 -- worker process id while running
    output_dir  TEXT,                    -- directory under data/jobs/
    metrics     TEXT,                    -- JSON: final metrics summary
    error       TEXT,
    created_at  REAL NOT NULL,
    started_at  REAL,
    finished_at REAL
);

CREATE TABLE IF NOT EXISTS agent_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    goal        TEXT NOT NULL,           -- what the user asked for, verbatim
    status      TEXT NOT NULL DEFAULT 'running',
                                         -- 'running' | 'succeeded' | 'failed'
    steps       TEXT,                    -- JSON: [{time, title, detail, status}]
    dataset_id  INTEGER,                 -- dataset the agent imported
    job_id      INTEGER,                 -- training job the agent launched
    error       TEXT,
    created_at  REAL NOT NULL,
    finished_at REAL
);

CREATE TABLE IF NOT EXISTS models (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT NOT NULL,
    job_id         INTEGER REFERENCES jobs(id),
    task           TEXT NOT NULL,
    base_model     TEXT,
    path           TEXT NOT NULL,        -- directory under data/models/
    metrics        TEXT,                 -- JSON copied from the producing job
    published_repo TEXT,                 -- HF repo id once published
    published_at   REAL,
    created_at     REAL NOT NULL
);
"""


def connect() -> sqlite3.Connection:
    """Open a connection with sane defaults. Callers should close it
    (or use ``with contextlib.closing(...)``); connections are cheap."""
    config.ensure_dirs()
    conn = sqlite3.connect(config.DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    return conn


def init_db() -> None:
    """Create tables if they don't exist. Called at server startup and by
    workers, so either side can start first."""
    with connect() as conn:
        conn.executescript(_SCHEMA)


# --------------------------------------------------------------------------
# Row helpers
# --------------------------------------------------------------------------

_JSON_FIELDS = {"columns", "hyperparams", "metrics", "steps"}


def row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    """Convert a DB row to a plain dict, decoding JSON columns."""
    if row is None:
        return None
    d = dict(row)
    for key in _JSON_FIELDS & d.keys():
        if d[key] is not None:
            try:
                d[key] = json.loads(d[key])
            except (TypeError, ValueError):
                pass  # leave the raw text; better than crashing a listing
    return d


def _dump(value: Any) -> str | None:
    return None if value is None else json.dumps(value)


# --------------------------------------------------------------------------
# Datasets
# --------------------------------------------------------------------------

def insert_dataset(name: str, source_type: str, source_ref: str, path: str,
                   status: str = "importing") -> int:
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO datasets (name, source_type, source_ref, path, status, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (name, source_type, source_ref, path, status, time.time()),
        )
        return int(cur.lastrowid)


def update_dataset(dataset_id: int, **fields: Any) -> None:
    _update("datasets", dataset_id, fields)


def get_dataset(dataset_id: int) -> dict[str, Any] | None:
    with connect() as conn:
        row = conn.execute("SELECT * FROM datasets WHERE id=?", (dataset_id,)).fetchone()
    return row_to_dict(row)


def list_datasets() -> list[dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute("SELECT * FROM datasets ORDER BY id DESC").fetchall()
    return [row_to_dict(r) for r in rows]


def delete_dataset(dataset_id: int) -> None:
    with connect() as conn:
        conn.execute("DELETE FROM datasets WHERE id=?", (dataset_id,))


# --------------------------------------------------------------------------
# Jobs
# --------------------------------------------------------------------------

def insert_job(name: str, dataset_id: int, task: str, base_model: str | None,
               hyperparams: dict[str, Any], output_dir: str) -> int:
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO jobs (name, dataset_id, task, base_model, hyperparams,"
            " output_dir, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (name, dataset_id, task, base_model, json.dumps(hyperparams),
             output_dir, time.time()),
        )
        return int(cur.lastrowid)


def update_job(job_id: int, **fields: Any) -> None:
    _update("jobs", job_id, fields)


def get_job(job_id: int) -> dict[str, Any] | None:
    with connect() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    return row_to_dict(row)


def list_jobs() -> list[dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute("SELECT * FROM jobs ORDER BY id DESC").fetchall()
    return [row_to_dict(r) for r in rows]


def delete_job(job_id: int) -> None:
    with connect() as conn:
        conn.execute("DELETE FROM jobs WHERE id=?", (job_id,))


# --------------------------------------------------------------------------
# Agent runs (Autopilot)
# --------------------------------------------------------------------------

def insert_agent_run(goal: str) -> int:
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO agent_runs (goal, steps, created_at) VALUES (?, ?, ?)",
            (goal, "[]", time.time()),
        )
        return int(cur.lastrowid)


def update_agent_run(run_id: int, **fields: Any) -> None:
    _update("agent_runs", run_id, fields)


def get_agent_run(run_id: int) -> dict[str, Any] | None:
    with connect() as conn:
        row = conn.execute("SELECT * FROM agent_runs WHERE id=?", (run_id,)).fetchone()
    return row_to_dict(row)


def list_agent_runs() -> list[dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute("SELECT * FROM agent_runs ORDER BY id DESC").fetchall()
    return [row_to_dict(r) for r in rows]


# --------------------------------------------------------------------------
# Models
# --------------------------------------------------------------------------

def insert_model(name: str, job_id: int | None, task: str, base_model: str | None,
                 path: str, metrics: dict[str, Any] | None) -> int:
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO models (name, job_id, task, base_model, path, metrics, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (name, job_id, task, base_model, path, _dump(metrics), time.time()),
        )
        return int(cur.lastrowid)


def update_model(model_id: int, **fields: Any) -> None:
    _update("models", model_id, fields)


def get_model(model_id: int) -> dict[str, Any] | None:
    with connect() as conn:
        row = conn.execute("SELECT * FROM models WHERE id=?", (model_id,)).fetchone()
    return row_to_dict(row)


def list_models() -> list[dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute("SELECT * FROM models ORDER BY id DESC").fetchall()
    return [row_to_dict(r) for r in rows]


def delete_model(model_id: int) -> None:
    with connect() as conn:
        conn.execute("DELETE FROM models WHERE id=?", (model_id,))


# --------------------------------------------------------------------------
# Internals
# --------------------------------------------------------------------------

def _update(table: str, row_id: int, fields: dict[str, Any]) -> None:
    """Generic ``UPDATE table SET ... WHERE id=?``.

    JSON-typed fields are serialized automatically so callers can pass dicts.
    ``table`` is always one of our three literals — never user input.
    """
    if not fields:
        return
    cols, vals = [], []
    for key, value in fields.items():
        if key in _JSON_FIELDS and value is not None and not isinstance(value, str):
            value = json.dumps(value)
        cols.append(f"{key}=?")
        vals.append(value)
    vals.append(row_id)
    with connect() as conn:
        conn.execute(f"UPDATE {table} SET {', '.join(cols)} WHERE id=?", vals)
