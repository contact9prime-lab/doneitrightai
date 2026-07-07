"""Dataset ingestion from public sources.

TrainForge can pull data three ways, all normalized to the same on-disk
format so the training workers never care where data came from:

1. **Hugging Face Hub** — search 100k+ public datasets by keyword straight
   from the UI, then import any of them (``search_hub`` / ``import_from_hub``).
2. **Direct URL** — any public CSV / TSV / JSON / JSONL / Parquet file
   (``import_from_url``).
3. **File upload** — drag a local file into the UI (``import_from_upload``).

Normalized layout, one directory per dataset::

    data/datasets/<id>/data.parquet

On import we also *profile* the data (column types, cardinality, sample
values) and store the profile in the DB. The UI and the training workers use
the profile to auto-suggest which column is the text and which is the label,
so training works out of the box without manual column mapping.

Imports run in a background thread: the API returns immediately with a
dataset row in status ``importing`` which flips to ``ready``/``failed``.
"""

from __future__ import annotations

import io
import json
import re
import threading
import traceback
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import pandas as pd
import requests

from .. import config, db

# Cap for values stored in the column profile, keeps DB rows small.
_SAMPLE_VALUES = 5
_MAX_UNIQUE_TRACKED = 1000


# --------------------------------------------------------------------------
# Search public sources
# --------------------------------------------------------------------------

def search_hub(query: str, limit: int = 25) -> list[dict[str, Any]]:
    """Keyword search over public datasets on the Hugging Face Hub.

    Anonymous access — no token required. Returns light-weight cards the UI
    renders as import candidates.
    """
    from huggingface_hub import HfApi  # lazy: keep server boot instant

    api = HfApi(token=config.hf_token())
    # sort="downloads" returns most-downloaded first; the 'direction' kwarg
    # was removed in huggingface_hub 1.x, so don't pass it.
    results = api.list_datasets(search=query, sort="downloads", limit=limit)
    cards = []
    for d in results:
        cards.append({
            "repo_id": d.id,
            "downloads": getattr(d, "downloads", None),
            "likes": getattr(d, "likes", None),
            "tags": [t for t in (d.tags or []) if ":" not in t][:8],
            "last_modified": str(getattr(d, "last_modified", "") or ""),
        })
    return cards


# --------------------------------------------------------------------------
# Import: Hugging Face Hub
# --------------------------------------------------------------------------

def import_from_hub(repo_id: str, config_name: str | None, split: str,
                    max_rows: int | None, name: str | None) -> dict[str, Any]:
    """Register a Hub dataset and download/convert it in the background."""
    display = name or repo_id.split("/")[-1]
    dataset_id = _register(display, "huggingface", repo_id)

    def work() -> None:
        from datasets import load_dataset  # lazy heavy import

        # Streaming keeps memory flat and honors max_rows without
        # downloading the full dataset first.
        if max_rows:
            stream = load_dataset(repo_id, config_name, split=split,
                                  streaming=True, token=config.hf_token())
            rows = []
            for i, row in enumerate(stream):
                if i >= max_rows:
                    break
                rows.append(row)
            df = pd.DataFrame(rows)
        else:
            ds = load_dataset(repo_id, config_name, split=split,
                              token=config.hf_token())
            df = ds.to_pandas()
        _finalize(dataset_id, df)

    _run_in_background(dataset_id, work)
    return db.get_dataset(dataset_id)


# --------------------------------------------------------------------------
# Import: direct URL
# --------------------------------------------------------------------------

def import_from_url(url: str, name: str | None) -> dict[str, Any]:
    """Register a URL dataset and download/parse it in the background."""
    filename = Path(urlparse(url).path).name or "download"
    display = name or filename
    dataset_id = _register(display, "url", url)

    def work() -> None:
        resp = requests.get(url, timeout=300)
        resp.raise_for_status()
        df = _parse_bytes(resp.content, filename or url)
        _finalize(dataset_id, df)

    _run_in_background(dataset_id, work)
    return db.get_dataset(dataset_id)


# --------------------------------------------------------------------------
# Import: file upload
# --------------------------------------------------------------------------

def import_from_upload(filename: str, content: bytes,
                       name: str | None) -> dict[str, Any]:
    """Parse an uploaded file. Runs synchronously — the bytes are already in
    memory, so parsing is fast and errors surface immediately."""
    display = name or filename
    dataset_id = _register(display, "upload", filename)
    try:
        df = _parse_bytes(content, filename)
        _finalize(dataset_id, df)
    except Exception as exc:  # report *any* parse failure on the row
        db.update_dataset(dataset_id, status="failed", error=str(exc))
    return db.get_dataset(dataset_id)


# --------------------------------------------------------------------------
# Reading data back (preview + workers)
# --------------------------------------------------------------------------

def dataset_path(dataset: dict[str, Any]) -> Path:
    return Path(dataset["path"]) / "data.parquet"


def load_dataframe(dataset: dict[str, Any]) -> pd.DataFrame:
    """Load a ready dataset as a DataFrame. Used by preview and workers."""
    return pd.read_parquet(dataset_path(dataset))


def preview(dataset: dict[str, Any], rows: int = 50) -> dict[str, Any]:
    """First N rows plus the stored column profile, JSON-safe."""
    df = load_dataframe(dataset).head(rows)
    # Convert non-JSON-native cells (numpy types, lists, bytes) to strings.
    records = json.loads(df.to_json(orient="records", default_handler=str))
    return {"rows": records, "columns": dataset.get("columns") or []}


# --------------------------------------------------------------------------
# Column profiling — powers auto-detection of text/label columns
# --------------------------------------------------------------------------

def profile_columns(df: pd.DataFrame) -> list[dict[str, Any]]:
    """Describe each column: dtype, cardinality, and sample values."""
    profile = []
    for col in df.columns:
        series = df[col]
        try:
            n_unique = int(series.nunique(dropna=True))
        except TypeError:  # unhashable cells (lists/dicts)
            n_unique = None
        samples = [str(v)[:120] for v in series.dropna().head(_SAMPLE_VALUES)]
        profile.append({
            "name": str(col),
            "dtype": str(series.dtype),
            "n_unique": n_unique if (n_unique is None or n_unique <= _MAX_UNIQUE_TRACKED)
                        else _MAX_UNIQUE_TRACKED,
            "unique_capped": bool(n_unique and n_unique >= _MAX_UNIQUE_TRACKED),
            "samples": samples,
        })
    return profile


def guess_text_column(df: pd.DataFrame) -> str | None:
    """Pick the most likely free-text column: prefer conventional names,
    otherwise the object column with the longest average string length."""
    preferred = ["text", "sentence", "content", "review", "prompt", "question",
                 "instruction", "document", "comment"]
    lower = {str(c).lower(): c for c in df.columns}
    for cand in preferred:
        if cand in lower:
            return str(lower[cand])

    best, best_len = None, 0.0
    for col in df.columns:
        if df[col].dtype == object:
            avg = df[col].dropna().astype(str).str.len().head(200).mean() or 0
            if avg > best_len:
                best, best_len = str(col), avg
    return best if best_len >= 20 else best  # any text beats nothing


def guess_label_column(df: pd.DataFrame) -> str | None:
    """Pick the most likely target column: conventional names first, then
    the lowest-cardinality column that isn't the text itself."""
    preferred = ["label", "labels", "target", "class", "category", "sentiment",
                 "score", "rating", "y"]
    lower = {str(c).lower(): c for c in df.columns}
    for cand in preferred:
        if cand in lower:
            return str(lower[cand])

    text_col = guess_text_column(df)
    best, best_card = None, None
    for col in df.columns:
        if str(col) == text_col:
            continue
        try:
            card = df[col].nunique(dropna=True)
        except TypeError:
            continue
        if 2 <= card <= 100 and (best_card is None or card < best_card):
            best, best_card = str(col), card
    return best


# --------------------------------------------------------------------------
# Internals
# --------------------------------------------------------------------------

def _register(name: str, source_type: str, source_ref: str) -> int:
    """Create the dataset row + its directory, in status 'importing'."""
    dataset_id = db.insert_dataset(name, source_type, source_ref, path="")
    directory = config.DATASETS_DIR / str(dataset_id)
    directory.mkdir(parents=True, exist_ok=True)
    db.update_dataset(dataset_id, path=str(directory))
    return dataset_id


def _finalize(dataset_id: int, df: pd.DataFrame) -> None:
    """Persist as parquet, profile columns, and mark the dataset ready."""
    if df.empty:
        raise ValueError("Import produced 0 rows — check the source/split.")
    df.columns = [str(c) for c in df.columns]  # parquet requires str names
    _coerce_unsupported(df)

    directory = config.DATASETS_DIR / str(dataset_id)
    out = directory / "data.parquet"
    df.to_parquet(out, index=False)
    db.update_dataset(
        dataset_id,
        status="ready",
        num_rows=int(len(df)),
        size_bytes=int(out.stat().st_size),
        columns=json.dumps(profile_columns(df)),
    )


def _coerce_unsupported(df: pd.DataFrame) -> None:
    """Parquet can't store arbitrary Python objects (dicts, mixed types).
    Coerce such columns to JSON strings rather than failing the import."""
    for col in df.columns:
        if df[col].dtype == object:
            head = df[col].dropna().head(20)
            if any(isinstance(v, (dict, list, tuple, set, bytes)) for v in head):
                df[col] = df[col].map(
                    lambda v: v if v is None else json.dumps(v, default=str))


def _parse_bytes(content: bytes, filename: str) -> pd.DataFrame:
    """Parse raw bytes by file extension into a DataFrame."""
    suffix = Path(re.sub(r"[?#].*$", "", filename)).suffix.lower()
    buf = io.BytesIO(content)
    if suffix in (".csv", ".txt", ""):
        return pd.read_csv(buf)
    if suffix == ".tsv":
        return pd.read_csv(buf, sep="\t")
    if suffix == ".parquet":
        return pd.read_parquet(buf)
    if suffix == ".jsonl":
        return pd.read_json(buf, lines=True)
    if suffix == ".json":
        try:
            return pd.read_json(buf)
        except ValueError:
            buf.seek(0)
            return pd.read_json(buf, lines=True)  # actually JSONL
    if suffix in (".xlsx", ".xls"):
        return pd.read_excel(buf)
    raise ValueError(f"Unsupported file type '{suffix}'. "
                     "Use CSV, TSV, JSON, JSONL, Parquet, or Excel.")


def _run_in_background(dataset_id: int, work) -> None:
    """Run an import in a daemon thread, recording failures on the row.

    Threads (not asyncio) because pandas/datasets are blocking libraries;
    daemon so a hung download never blocks server shutdown.
    """
    def wrapper() -> None:
        try:
            work()
        except Exception as exc:
            traceback.print_exc()
            db.update_dataset(dataset_id, status="failed", error=str(exc)[:2000])

    threading.Thread(target=wrapper, daemon=True,
                     name=f"import-dataset-{dataset_id}").start()
