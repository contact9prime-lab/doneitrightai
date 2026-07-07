"""Training job runner.

Every training job runs in its **own OS process** (never inside the API
server) for three reasons:

1. **Isolation** — a CUDA OOM or a segfault in a training library kills the
   job, not the platform.
2. **GPU memory hygiene** — when the process exits, the driver reclaims all
   GPU memory. No fragmentation across jobs.
3. **Stoppability** — stopping a job is a signal to a process group, which
   reliably tears down DataLoader workers too.

The worker entrypoint is ``python -m server.workers.train_worker --job-id N``.
Workers own their DB row: they flip it to running/succeeded/failed and stream
logs + metrics to files inside the job directory::

    data/jobs/<id>/
        job.log         # combined stdout+stderr, tailed by the UI
        metrics.jsonl   # one JSON object per logged training step
        output/         # checkpoints + final model

The runner also *reaps*: if a worker dies without updating its row (kill -9,
power loss), the next status read detects the dead PID and marks the job
failed instead of showing "running" forever.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from .. import config, db

# Jobs at most this many can run concurrently. Single-GPU boxes should keep
# this at 1; the queue drains FIFO as jobs finish.
MAX_CONCURRENT = int(os.environ.get("TRAINFORGE_MAX_CONCURRENT_JOBS", "1"))


def create_and_launch(name: str, dataset_id: int, task: str,
                      base_model: str | None,
                      hyperparams: dict[str, Any]) -> dict[str, Any]:
    """Insert the job row, create its directory, and launch or queue it."""
    job_id = db.insert_job(name, dataset_id, task, base_model, hyperparams,
                           output_dir="")
    job_dir = config.JOBS_DIR / str(job_id)
    (job_dir / "output").mkdir(parents=True, exist_ok=True)
    db.update_job(job_id, output_dir=str(job_dir))

    _launch_if_capacity(job_id)
    return refresh_status(db.get_job(job_id))


def refresh_status(job: dict[str, Any] | None) -> dict[str, Any] | None:
    """Reconcile DB state with reality before returning a job to a caller.

    - running + dead PID  -> failed (worker crashed without cleanup)
    - queued + free slot  -> launched now (drains the queue on any poll)
    """
    if job is None:
        return None
    if job["status"] == "running" and job["pid"] and not _pid_alive(job["pid"]):
        db.update_job(job["id"], status="failed", finished_at=time.time(),
                      error="Worker process died unexpectedly (see job.log).")
        job = db.get_job(job["id"])
    elif job["status"] == "queued":
        _launch_if_capacity(job["id"])
        job = db.get_job(job["id"])
    return job


def stop(job_id: int) -> dict[str, Any] | None:
    """Politely stop a running job (SIGTERM to its process group)."""
    job = db.get_job(job_id)
    if job and job["status"] == "running" and job["pid"]:
        try:
            os.killpg(job["pid"], signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass  # already gone
        db.update_job(job_id, status="stopped", finished_at=time.time())
    elif job and job["status"] == "queued":
        db.update_job(job_id, status="stopped", finished_at=time.time())
    return db.get_job(job_id)


def read_log(job: dict[str, Any], offset: int = 0,
             max_bytes: int = 200_000) -> dict[str, Any]:
    """Tail the job log from ``offset``; the UI polls with the returned
    offset for incremental streaming without a websocket."""
    path = Path(job["output_dir"]) / "job.log"
    if not path.exists():
        return {"content": "", "offset": 0, "size": 0}
    size = path.stat().st_size
    offset = max(0, min(offset, size))
    with open(path, "rb") as fh:
        fh.seek(offset)
        chunk = fh.read(max_bytes)
    return {"content": chunk.decode("utf-8", errors="replace"),
            "offset": offset + len(chunk), "size": size}


def read_metrics(job: dict[str, Any]) -> list[dict[str, Any]]:
    """Parse metrics.jsonl written by the worker (one dict per step)."""
    path = Path(job["output_dir"]) / "metrics.jsonl"
    if not path.exists():
        return []
    points = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                points.append(json.loads(line))
            except ValueError:
                continue  # torn write mid-poll; next poll gets it
    return points


# --------------------------------------------------------------------------
# Internals
# --------------------------------------------------------------------------

def _launch_if_capacity(job_id: int) -> None:
    """Start the worker process unless MAX_CONCURRENT jobs already run."""
    running = [j for j in db.list_jobs()
               if j["status"] == "running" and j["pid"] and _pid_alive(j["pid"])]
    if len(running) >= MAX_CONCURRENT:
        return  # stays 'queued'; drained by refresh_status on later polls

    job = db.get_job(job_id)
    if not job or job["status"] != "queued":
        return

    log_path = Path(job["output_dir"]) / "job.log"
    log_file = open(log_path, "ab")
    # start_new_session=True puts the worker in its own process group so
    # stop() can signal the whole tree (worker + DataLoader children).
    proc = subprocess.Popen(
        [sys.executable, "-u", "-m", "server.workers.train_worker",
         "--job-id", str(job_id)],
        stdout=log_file, stderr=subprocess.STDOUT,
        cwd=config.APP_ROOT, start_new_session=True,
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
    )
    log_file.close()  # the child holds its own fd now
    db.update_job(job_id, status="running", pid=proc.pid,
                  started_at=time.time())


def _pid_alive(pid: int) -> bool:
    """True if a process with this PID exists (signal 0 probe)."""
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # exists, owned by someone else
