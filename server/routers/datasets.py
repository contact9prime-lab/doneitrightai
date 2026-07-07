"""Dataset endpoints: search public sources, import, inspect, delete."""

from __future__ import annotations

import shutil
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, UploadFile

from .. import db
from ..schemas import HubImportRequest, UrlImportRequest
from ..services import ingest

router = APIRouter(prefix="/api/datasets", tags=["datasets"])


@router.get("")
def list_datasets() -> list[dict]:
    return db.list_datasets()


@router.get("/search-hub")
def search_hub(q: str = Query(..., min_length=1),
               limit: int = Query(25, ge=1, le=100)) -> list[dict]:
    """Keyword search over public Hugging Face Hub datasets — this is how
    the platform 'finds data' for whatever you're looking for."""
    try:
        return ingest.search_hub(q, limit=limit)
    except Exception as exc:
        raise HTTPException(502, f"Hub search failed: {exc}")


@router.post("/import-hub", status_code=202)
def import_hub(req: HubImportRequest) -> dict:
    """Start a background import of a Hub dataset. Poll GET /{id} until
    status becomes 'ready' (or 'failed' with an error message)."""
    return ingest.import_from_hub(req.repo_id, req.config_name, req.split,
                                  req.max_rows, req.name)


@router.post("/import-url", status_code=202)
def import_url(req: UrlImportRequest) -> dict:
    """Start a background import of a public CSV/JSON/JSONL/Parquet URL."""
    return ingest.import_from_url(req.url, req.name)


@router.post("/upload", status_code=201)
async def upload(file: UploadFile, name: str | None = None) -> dict:
    """Import an uploaded file (synchronous — errors surface immediately)."""
    content = await file.read()
    if not content:
        raise HTTPException(400, "Uploaded file is empty.")
    result = ingest.import_from_upload(file.filename or "upload", content, name)
    if result and result["status"] == "failed":
        raise HTTPException(400, f"Could not parse file: {result['error']}")
    return result


@router.get("/{dataset_id}")
def get_dataset(dataset_id: int) -> dict:
    dataset = db.get_dataset(dataset_id)
    if dataset is None:
        raise HTTPException(404, "Dataset not found")
    return dataset


@router.get("/{dataset_id}/preview")
def preview(dataset_id: int, rows: int = Query(50, ge=1, le=500)) -> dict:
    """First rows + column profile, including auto-detected text/label
    column suggestions used to prefill the training form."""
    dataset = db.get_dataset(dataset_id)
    if dataset is None:
        raise HTTPException(404, "Dataset not found")
    if dataset["status"] != "ready":
        raise HTTPException(409, f"Dataset is {dataset['status']}, not ready")
    df = ingest.load_dataframe(dataset)
    data = ingest.preview(dataset, rows)
    data["suggested_text_column"] = ingest.guess_text_column(df)
    data["suggested_label_column"] = ingest.guess_label_column(df)
    return data


@router.delete("/{dataset_id}", status_code=204)
def delete_dataset(dataset_id: int) -> None:
    """Delete the dataset row and its files. Jobs that already trained from
    it keep their own copies, so nothing breaks retroactively."""
    dataset = db.get_dataset(dataset_id)
    if dataset is None:
        raise HTTPException(404, "Dataset not found")
    if dataset["path"]:
        shutil.rmtree(Path(dataset["path"]), ignore_errors=True)
    db.delete_dataset(dataset_id)
