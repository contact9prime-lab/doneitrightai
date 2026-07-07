"""Worker entrypoint — one process per training job.

Launched by ``server.services.runner`` as::

    python -u -m server.workers.train_worker --job-id 42

Responsibilities:

1. Load the job + dataset rows from SQLite.
2. Dispatch to the right task trainer (``workers.tasks``).
3. Stream progress: stdout/stderr already go to ``job.log`` (the runner
   wired the pipes); scalar metrics go to ``metrics.jsonl`` via ``JobContext``.
4. On success: register the produced model in the ``models`` table and mark
   the job ``succeeded``. On any exception: mark it ``failed`` with the error.

The process exits 0 on success, 1 on failure — but the DB row is the source
of truth, not the exit code.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pandas as pd

from .. import config, db
from ..services import ingest
from .tasks import TASKS


@dataclass
class JobContext:
    """Everything a task trainer needs, in one bag.

    Trainers return a dict of final metrics; they write their model artifact
    into ``ctx.model_out`` which this entrypoint then registers.
    """

    job: dict[str, Any]
    dataset: dict[str, Any]
    df: pd.DataFrame
    hyperparams: dict[str, Any]
    job_dir: Path
    model_out: Path                       # trainers save the final model here
    _metrics_fh: Any = field(default=None, repr=False)

    def log_metrics(self, point: dict[str, Any]) -> None:
        """Append one metrics point (loss, accuracy, ...) to metrics.jsonl.

        Flushed per line so the UI chart updates live while training runs.
        """
        if self._metrics_fh is None:
            self._metrics_fh = open(self.job_dir / "metrics.jsonl", "a",
                                    encoding="utf-8")
        self._metrics_fh.write(json.dumps({"time": time.time(), **point}) + "\n")
        self._metrics_fh.flush()

    def say(self, message: str) -> None:
        """Human-readable progress line (lands in job.log via stdout)."""
        print(f"[trainforge] {message}", flush=True)


def merge_hyperparams(task_module, task: str,
                      user: dict[str, Any]) -> dict[str, Any]:
    """Defaults from the task SPEC, overridden by user-provided values.

    Values are coerced to the declared type so "3" from a web form works
    where the trainer expects an int.
    """
    spec = next(s for s in task_module.SPEC if s["task"] == task)
    merged: dict[str, Any] = {}
    for param in spec["hyperparams"]:
        value = user.get(param["name"], param["default"])
        kind = param["type"]
        try:
            if value is None or value == "":
                value = param["default"]
            elif kind == "int":
                value = int(value)
            elif kind == "float":
                value = float(value)
            elif kind == "bool":
                value = value if isinstance(value, bool) else str(value).lower() in ("1", "true", "yes")
            else:
                value = str(value)
        except (TypeError, ValueError):
            value = param["default"]
        merged[param["name"]] = value
    return merged


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--job-id", type=int, required=True)
    args = parser.parse_args()

    db.init_db()
    job = db.get_job(args.job_id)
    if job is None:
        print(f"[trainforge] job {args.job_id} not found", file=sys.stderr)
        return 1

    dataset = db.get_dataset(job["dataset_id"])
    job_dir = Path(job["output_dir"])
    model_out = job_dir / "output"
    model_out.mkdir(parents=True, exist_ok=True)

    try:
        if dataset is None or dataset["status"] != "ready":
            raise RuntimeError("Dataset is missing or not ready.")

        task_module = TASKS.get(job["task"])
        if task_module is None:
            raise RuntimeError(f"Unknown task '{job['task']}'.")

        ctx = JobContext(
            job=job,
            dataset=dataset,
            df=ingest.load_dataframe(dataset),
            hyperparams=merge_hyperparams(task_module, job["task"],
                                          job["hyperparams"] or {}),
            job_dir=job_dir,
            model_out=model_out,
        )
        ctx.say(f"job #{job['id']} '{job['name']}' — task={job['task']} "
                f"dataset='{dataset['name']}' rows={len(ctx.df)}")
        ctx.say(f"hyperparameters: {json.dumps(ctx.hyperparams)}")

        metrics = task_module.train(ctx)

        _register_model(job, metrics, model_out)
        db.update_job(job["id"], status="succeeded", metrics=metrics,
                      finished_at=time.time())
        ctx.say(f"done — final metrics: {json.dumps(metrics)}")
        return 0

    except Exception as exc:
        traceback.print_exc()
        db.update_job(job["id"], status="failed", error=str(exc)[:4000],
                      finished_at=time.time())
        return 1


def _register_model(job: dict[str, Any], metrics: dict[str, Any],
                    model_out: Path) -> None:
    """Copy the final artifact into the model registry and insert its row.

    Copy (not move/symlink) so deleting a job later never breaks a
    registered model, and vice versa.
    """
    model_id = db.insert_model(
        name=job["name"], job_id=job["id"], task=job["task"],
        base_model=job["base_model"], path="", metrics=metrics)
    dest = config.MODELS_DIR / str(model_id)
    shutil.copytree(model_out, dest, dirs_exist_ok=True)
    db.update_model(model_id, path=str(dest))


if __name__ == "__main__":
    sys.exit(main())
