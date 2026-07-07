"""Pydantic request/response schemas for the HTTP API.

Only *request* bodies are strictly modeled. Responses are plain dicts read
from the database (see ``server.db.row_to_dict``) so that adding a column
never requires touching two places.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

# Tasks supported by the training workers. Keep in sync with
# ``server/workers/tasks`` and the task picker in ``ui/app.js``.
TaskName = Literal[
    "tabular-classification",
    "tabular-regression",
    "text-classification",
    "causal-lm",
]


class HubImportRequest(BaseModel):
    """Import a public dataset from the Hugging Face Hub."""

    repo_id: str = Field(..., description="Dataset repo, e.g. 'imdb' or 'glue'")
    config_name: str | None = Field(
        None, description="Dataset config/subset, e.g. 'sst2' for 'glue'")
    split: str = Field(
        "train", description="Split to import; workers create their own "
                             "validation split when needed")
    max_rows: int | None = Field(
        None, ge=1, description="Optional row cap for quick experiments")
    name: str | None = Field(None, description="Display name; defaults to repo_id")


class UrlImportRequest(BaseModel):
    """Import a dataset from a direct public URL (CSV/TSV/JSON/JSONL/Parquet)."""

    url: str
    name: str | None = None


class JobCreateRequest(BaseModel):
    """Create (and immediately launch) a training job."""

    name: str = Field(..., min_length=1, max_length=200)
    dataset_id: int
    task: TaskName
    base_model: str | None = Field(
        None, description="HF model id for deep-learning tasks, e.g. "
                          "'distilbert-base-uncased' or 'TinyLlama/TinyLlama-1.1B-Chat-v1.0'")
    # Free-form, validated by each task's trainer against its own defaults —
    # see server/workers/tasks/*.py for the exact keys each task accepts.
    hyperparams: dict[str, Any] = Field(default_factory=dict)


class PublishRequest(BaseModel):
    """Publish a registered model to the Hugging Face Hub."""

    repo_id: str = Field(..., description="Target repo, e.g. 'your-username/my-model'")
    private: bool = Field(True, description="Create the repo as private (default)")
    token: str | None = Field(
        None, description="HF write token; falls back to the HF_TOKEN env var. "
                          "Used for this request only — never stored.")
