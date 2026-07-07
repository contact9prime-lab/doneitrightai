"""System endpoints: health, hardware, capabilities, and the task catalog."""

from __future__ import annotations

from fastapi import APIRouter

from .. import __version__, config
from ..services import gpu
from ..workers import tasks

router = APIRouter(prefix="/api/system", tags=["system"])


@router.get("/health")
def health() -> dict:
    """Liveness probe. Also used by run.sh to wait for boot."""
    return {"status": "ok", "version": __version__}


@router.get("/info")
def info() -> dict:
    """Everything the dashboard shows: GPUs, torch status, installed
    capabilities, data directory, and HF token presence (never the token)."""
    return {
        "version": __version__,
        "data_dir": str(config.DATA_DIR),
        "hf_token_configured": config.hf_token() is not None,
        "capabilities": gpu.capabilities(),
        **gpu.gpu_info(),
    }


@router.get("/tasks")
def task_catalog() -> list[dict]:
    """Task specs (hyperparameter schemas included). The UI renders its
    training form from this — the API is the single source of truth."""
    caps = gpu.capabilities()
    specs = tasks.all_specs()
    for spec in specs:
        missing = [m for m in spec["requires"] if not caps.get(m)]
        spec["available"] = not missing
        spec["missing_requirements"] = missing
    return specs
