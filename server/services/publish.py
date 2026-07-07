"""Publishing trained models to the Hugging Face Hub.

Takes a model directory produced by a training worker, generates a model
card (README.md) if one doesn't exist, creates the target repo (private by
default), and uploads the folder.

Token resolution order:
1. token passed in the publish request (used once, never stored)
2. ``HF_TOKEN`` environment variable

Get a write token at https://huggingface.co/settings/tokens.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from .. import config, db


def publish_model(model: dict[str, Any], repo_id: str, private: bool,
                  token: str | None) -> dict[str, Any]:
    """Upload a registered model to the Hub and record the publication."""
    from huggingface_hub import HfApi  # lazy heavy import

    token = token or config.hf_token()
    if not token:
        raise PermissionError(
            "No Hugging Face token. Set the HF_TOKEN environment variable or "
            "paste a write token in the publish dialog "
            "(https://huggingface.co/settings/tokens).")

    model_dir = Path(model["path"])
    if not model_dir.is_dir():
        raise FileNotFoundError(f"Model directory missing: {model_dir}")

    _ensure_model_card(model, model_dir)

    api = HfApi(token=token)
    api.create_repo(repo_id=repo_id, repo_type="model", private=private,
                    exist_ok=True)
    api.upload_folder(
        folder_path=str(model_dir),
        repo_id=repo_id,
        repo_type="model",
        commit_message=f"Upload {model['name']} trained with TrainForge",
    )

    db.update_model(model["id"], published_repo=repo_id,
                    published_at=time.time())
    return db.get_model(model["id"])


def _ensure_model_card(model: dict[str, Any], model_dir: Path) -> None:
    """Write a README.md model card if the trainer didn't produce one.

    The card carries provenance (task, base model, metrics, TrainForge) so a
    model on the Hub is self-describing.
    """
    card = model_dir / "README.md"
    if card.exists():
        return

    metrics = model.get("metrics") or {}
    metrics_lines = "\n".join(
        f"- **{k}**: {v}" for k, v in metrics.items()
        if isinstance(v, (int, float, str))
    ) or "_no metrics recorded_"
    base = model.get("base_model") or "n/a"

    card.write_text(f"""---
tags:
- trainforge
{f'base_model: {base}' if base != 'n/a' else ''}
---

# {model['name']}

Trained with [TrainForge](https://github.com/contact9prime-lab/doneitrightai),
a self-hosted GPU ML training platform.

- **Task**: `{model['task']}`
- **Base model**: `{base}`

## Metrics

{metrics_lines}

## Usage

See the files in this repository. Transformers models load with
`AutoModel.from_pretrained("<this repo>")`; tabular models are
scikit-learn pipelines loadable with `joblib.load("model.joblib")`.
""", encoding="utf-8")
