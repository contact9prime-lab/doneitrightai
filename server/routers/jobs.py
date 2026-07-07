"""Training job endpoints: create/launch, monitor, stop, delete."""

from __future__ import annotations

import shutil
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query

from .. import db
from ..schemas import JobCreateRequest
from ..services import runner

router = APIRouter(prefix="/api/jobs", tags=["jobs"])


@router.get("")
def list_jobs() -> list[dict]:
    """All jobs, newest first, with statuses reconciled against live PIDs."""
    return [runner.refresh_status(j) for j in db.list_jobs()]


@router.post("", status_code=201)
def create_job(req: JobCreateRequest) -> dict:
    """Create a job and launch it immediately (or queue it if the
    concurrency limit is reached — see TRAINFORGE_MAX_CONCURRENT_JOBS)."""
    dataset = db.get_dataset(req.dataset_id)
    if dataset is None:
        raise HTTPException(404, "Dataset not found")
    if dataset["status"] != "ready":
        raise HTTPException(409, f"Dataset is {dataset['status']}, not ready")
    return runner.create_and_launch(req.name, req.dataset_id, req.task,
                                    req.base_model, req.hyperparams)


@router.get("/{job_id}")
def get_job(job_id: int) -> dict:
    job = runner.refresh_status(db.get_job(job_id))
    if job is None:
        raise HTTPException(404, "Job not found")
    return job


@router.get("/{job_id}/logs")
def logs(job_id: int, offset: int = Query(0, ge=0)) -> dict:
    """Incremental log tail. Pass the returned 'offset' back on the next
    poll to receive only new bytes — that's the whole streaming protocol."""
    job = db.get_job(job_id)
    if job is None:
        raise HTTPException(404, "Job not found")
    return runner.read_log(job, offset)


@router.get("/{job_id}/metrics")
def metrics(job_id: int) -> list[dict]:
    """All metric points logged so far (loss curves, accuracy, ...)."""
    job = db.get_job(job_id)
    if job is None:
        raise HTTPException(404, "Job not found")
    return runner.read_metrics(job)


@router.post("/{job_id}/stop")
def stop(job_id: int) -> dict:
    job = runner.stop(job_id)
    if job is None:
        raise HTTPException(404, "Job not found")
    return job


@router.delete("/{job_id}", status_code=204)
def delete_job(job_id: int) -> None:
    """Delete a finished job and its working directory. Running jobs must
    be stopped first; registered models have their own copies and survive."""
    job = db.get_job(job_id)
    if job is None:
        raise HTTPException(404, "Job not found")
    if runner.refresh_status(job)["status"] == "running":
        raise HTTPException(409, "Stop the job before deleting it")
    if job["output_dir"]:
        shutil.rmtree(Path(job["output_dir"]), ignore_errors=True)
    db.delete_job(job_id)
