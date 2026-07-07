"""GPU and capability detection.

Two independent probes, both failure-tolerant:

1. ``nvidia-smi`` — reports every NVIDIA GPU with live memory/utilization.
   Works even when PyTorch isn't installed yet.
2. ``torch.cuda`` — confirms that the *training stack* can actually see the
   GPU (a driver can be present while torch is CPU-only).

The UI dashboard shows both so a misconfigured install is obvious at a
glance instead of failing 20 minutes into a job.
"""

from __future__ import annotations

import importlib.util
import shutil
import subprocess
from typing import Any


def gpu_info() -> dict[str, Any]:
    """Return {'gpus': [...], 'torch': {...}} — safe to call anywhere."""
    return {"gpus": _nvidia_smi(), "torch": _torch_info()}


def capabilities() -> dict[str, bool]:
    """Which optional ML stacks are importable. Drives the UI: tasks whose
    stack is missing are shown disabled with an install hint."""
    return {
        "torch": _has("torch"),
        "transformers": _has("transformers"),
        "peft": _has("peft"),
        "sklearn": _has("sklearn"),
        "datasets": _has("datasets"),
        "huggingface_hub": _has("huggingface_hub"),
    }


def _has(module: str) -> bool:
    try:
        return importlib.util.find_spec(module) is not None
    except (ImportError, ValueError):
        return False


def _nvidia_smi() -> list[dict[str, Any]]:
    """Parse ``nvidia-smi`` CSV output. Returns [] on any failure —
    machines without NVIDIA GPUs are a supported configuration."""
    if not shutil.which("nvidia-smi"):
        return []
    try:
        out = subprocess.run(
            ["nvidia-smi",
             "--query-gpu=index,name,memory.total,memory.used,utilization.gpu,temperature.gpu",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=10, check=True,
        ).stdout
    except (subprocess.SubprocessError, OSError):
        return []

    gpus = []
    for line in out.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 6:
            continue
        try:
            gpus.append({
                "index": int(parts[0]),
                "name": parts[1],
                "memory_total_mb": int(parts[2]),
                "memory_used_mb": int(parts[3]),
                "utilization_pct": int(parts[4]),
                "temperature_c": int(parts[5]),
            })
        except ValueError:
            continue  # e.g. "[N/A]" fields on exotic drivers
    return gpus


def _torch_info() -> dict[str, Any]:
    try:
        import torch
    except ImportError:
        return {"installed": False, "cuda_available": False}
    info: dict[str, Any] = {
        "installed": True,
        "version": torch.__version__,
        "cuda_available": torch.cuda.is_available(),
    }
    if info["cuda_available"]:
        info["cuda_version"] = torch.version.cuda
        info["device_count"] = torch.cuda.device_count()
        info["device_name"] = torch.cuda.get_device_name(0)
    return info
