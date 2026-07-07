"""Model registry endpoints: list, inspect, publish to Hugging Face, delete."""

from __future__ import annotations

import shutil
from pathlib import Path

from fastapi import APIRouter, HTTPException

from .. import db
from ..schemas import PublishRequest
from ..services import publish

router = APIRouter(prefix="/api/models", tags=["models"])


@router.get("")
def list_models() -> list[dict]:
    return db.list_models()


@router.get("/{model_id}")
def get_model(model_id: int) -> dict:
    model = db.get_model(model_id)
    if model is None:
        raise HTTPException(404, "Model not found")
    return model


@router.get("/{model_id}/files")
def files(model_id: int) -> list[dict]:
    """List the artifact's files (name + size) so users can see exactly
    what would be uploaded before publishing."""
    model = db.get_model(model_id)
    if model is None:
        raise HTTPException(404, "Model not found")
    root = Path(model["path"])
    if not root.is_dir():
        return []
    return sorted(
        ({"name": str(p.relative_to(root)), "size_bytes": p.stat().st_size}
         for p in root.rglob("*") if p.is_file()),
        key=lambda f: f["name"])


@router.post("/{model_id}/publish")
def publish_model(model_id: int, req: PublishRequest) -> dict:
    """Upload the model folder to the Hugging Face Hub (private by default).

    The request token, if provided, is used once and never stored.
    """
    model = db.get_model(model_id)
    if model is None:
        raise HTTPException(404, "Model not found")
    try:
        return publish.publish_model(model, req.repo_id, req.private, req.token)
    except PermissionError as exc:
        raise HTTPException(401, str(exc))
    except FileNotFoundError as exc:
        raise HTTPException(410, str(exc))
    except Exception as exc:
        raise HTTPException(502, f"Publish failed: {exc}")


@router.delete("/{model_id}", status_code=204)
def delete_model(model_id: int) -> None:
    model = db.get_model(model_id)
    if model is None:
        raise HTTPException(404, "Model not found")
    if model["path"]:
        shutil.rmtree(Path(model["path"]), ignore_errors=True)
    db.delete_model(model_id)
