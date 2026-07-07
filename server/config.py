"""Configuration for TrainForge.

Everything is driven by environment variables so the platform works out of
the box with zero configuration, yet can be adapted without touching code.

Variables (all optional):

- ``TRAINFORGE_DATA_DIR``  — where datasets, job outputs, trained models and
                             the SQLite database live. Default: ``./data``
                             (relative to the repository root).
- ``TRAINFORGE_HOST``      — bind address for the server. Default ``0.0.0.0``
                             so the UI is reachable from your LAN.
- ``TRAINFORGE_PORT``      — port for the server. Default ``8000``.
- ``HF_TOKEN``             — Hugging Face access token. Needed only for
                             publishing models to the Hub (and for importing
                             gated datasets). Create one at
                             https://huggingface.co/settings/tokens with the
                             "write" role.
"""

from __future__ import annotations

import os
from pathlib import Path

# Repository root = the directory containing this ``server`` package.
APP_ROOT = Path(__file__).resolve().parent.parent

# Root of all mutable state. Everything TrainForge writes lives under here,
# which makes backup/migration a single directory copy.
DATA_DIR = Path(os.environ.get("TRAINFORGE_DATA_DIR", APP_ROOT / "data")).resolve()

# Sub-directories, created on demand by ensure_dirs().
DATASETS_DIR = DATA_DIR / "datasets"   # one folder per imported dataset
JOBS_DIR = DATA_DIR / "jobs"           # one folder per training job (logs, checkpoints)
MODELS_DIR = DATA_DIR / "models"       # final exported models, ready to publish
DB_PATH = DATA_DIR / "trainforge.db"   # SQLite database

HOST = os.environ.get("TRAINFORGE_HOST", "0.0.0.0")
PORT = int(os.environ.get("TRAINFORGE_PORT", "8000"))


def hf_token() -> str | None:
    """Return the Hugging Face token, if configured.

    Read lazily (not at import time) so users can export ``HF_TOKEN`` and
    restart nothing more than the server process.
    """
    return os.environ.get("HF_TOKEN") or None


def ensure_dirs() -> None:
    """Create the on-disk layout. Safe to call repeatedly."""
    for d in (DATA_DIR, DATASETS_DIR, JOBS_DIR, MODELS_DIR):
        d.mkdir(parents=True, exist_ok=True)
