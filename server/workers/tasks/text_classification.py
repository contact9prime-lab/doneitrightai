"""Text classification by fine-tuning a Transformer encoder on the GPU.

Fine-tunes any Hugging Face sequence-classification checkpoint (default:
``distilbert-base-uncased``) on a text + label column pair. Columns are
auto-detected from the dataset profile but can be overridden.

Artifacts saved to the model registry:
    config.json / model.safetensors / tokenizer files   (standard HF layout)
    label_mapping.json                                  (id <-> label names)

so the published model loads anywhere with::

    from transformers import pipeline
    clf = pipeline("text-classification", model="<repo or path>")

Live metrics: a ``TrainerCallback`` forwards every Trainer log (loss,
eval_accuracy, ...) to ``metrics.jsonl``, which the UI charts in real time.
"""

from __future__ import annotations

import json
from typing import Any

SPEC = [
    {
        "task": "text-classification",
        "label": "Text classification (Transformers)",
        "needs_gpu": True,
        "needs_base_model": True,
        "default_base_model": "distilbert-base-uncased",
        "requires": ["torch", "transformers"],
        "description": "Fine-tune a Transformer to classify text "
                       "(sentiment, topics, intent...). GPU strongly recommended.",
        "hyperparams": [
            {"name": "text_column", "type": "str", "default": "",
             "help": "Column containing the text. Blank = auto-detect."},
            {"name": "label_column", "type": "str", "default": "",
             "help": "Column containing the class. Blank = auto-detect."},
            {"name": "epochs", "type": "float", "default": 3,
             "help": "Passes over the training data."},
            {"name": "learning_rate", "type": "float", "default": 5e-5,
             "help": "AdamW peak learning rate."},
            {"name": "batch_size", "type": "int", "default": 16,
             "help": "Per-device batch size. Lower it if you hit CUDA OOM."},
            {"name": "max_length", "type": "int", "default": 256,
             "help": "Token truncation length."},
            {"name": "eval_fraction", "type": "float", "default": 0.1,
             "help": "Fraction held out for evaluation."},
            {"name": "seed", "type": "int", "default": 42,
             "help": "Random seed for reproducibility."},
        ],
    },
]


def train(ctx) -> dict[str, Any]:
    # Heavy imports here: the API server imports this module for SPEC only.
    import numpy as np
    import torch
    from datasets import Dataset
    from transformers import (AutoModelForSequenceClassification,
                              AutoTokenizer, Trainer, TrainerCallback,
                              TrainingArguments)

    from ...services import ingest

    hp = ctx.hyperparams
    df = ctx.df
    base_model = ctx.job["base_model"] or "distilbert-base-uncased"

    # ---- resolve columns ----
    text_col = hp["text_column"] or ingest.guess_text_column(df)
    label_col = hp["label_column"] or ingest.guess_label_column(df)
    if not text_col or text_col not in df.columns:
        raise RuntimeError(f"Set 'text_column'; available: {list(df.columns)}")
    if not label_col or label_col not in df.columns:
        raise RuntimeError(f"Set 'label_column'; available: {list(df.columns)}")
    ctx.say(f"text column: '{text_col}', label column: '{label_col}', "
            f"base model: {base_model}")

    df = df.dropna(subset=[text_col, label_col])

    # ---- encode labels as contiguous ids, keep the human names ----
    label_names = sorted(str(v) for v in df[label_col].unique())
    if len(label_names) < 2:
        raise RuntimeError("Need at least 2 distinct label values.")
    label2id = {name: i for i, name in enumerate(label_names)}
    id2label = {i: name for name, i in label2id.items()}

    device = "cuda" if torch.cuda.is_available() else "cpu"
    ctx.say(f"device: {device}"
            + ("" if device == "cuda" else "  (no GPU visible — this will be slow)"))

    # ---- tokenize ----
    tokenizer = AutoTokenizer.from_pretrained(base_model)
    ds = Dataset.from_dict({
        "text": df[text_col].astype(str).tolist(),
        "label": [label2id[str(v)] for v in df[label_col]],
    })
    ds = ds.map(
        lambda batch: tokenizer(batch["text"], truncation=True,
                                max_length=hp["max_length"]),
        batched=True, remove_columns=["text"])
    split = ds.train_test_split(test_size=hp["eval_fraction"], seed=hp["seed"])

    model = AutoModelForSequenceClassification.from_pretrained(
        base_model, num_labels=len(label_names),
        label2id=label2id, id2label=id2label)

    def compute_metrics(eval_pred):
        logits, labels = eval_pred
        preds = np.argmax(logits, axis=-1)
        return {"accuracy": float((preds == labels).mean())}

    class ForwardMetrics(TrainerCallback):
        """Pipe every Trainer log line into metrics.jsonl for the UI chart."""
        def on_log(self, args, state, control, logs=None, **kwargs):
            if logs:
                point = {k: v for k, v in logs.items()
                         if isinstance(v, (int, float))}
                if point:
                    ctx.log_metrics({"step": state.global_step,
                                     "epoch": round(state.epoch or 0, 3),
                                     **point})

    train_args = TrainingArguments(
        output_dir=str(ctx.job_dir / "checkpoints"),
        num_train_epochs=hp["epochs"],
        learning_rate=hp["learning_rate"],
        per_device_train_batch_size=hp["batch_size"],
        per_device_eval_batch_size=hp["batch_size"] * 2,
        eval_strategy="epoch",
        save_strategy="epoch",
        save_total_limit=1,                       # cap disk usage
        load_best_model_at_end=True,
        metric_for_best_model="accuracy",
        logging_steps=10,
        seed=hp["seed"],
        fp16=(device == "cuda"),                  # mixed precision on GPU
        report_to=[],                             # no external trackers
    )
    trainer = Trainer(model=model, args=train_args,
                      train_dataset=split["train"],
                      eval_dataset=split["test"],
                      processing_class=tokenizer,
                      compute_metrics=compute_metrics,
                      callbacks=[ForwardMetrics()])

    ctx.say(f"training on {len(split['train'])} rows, "
            f"evaluating on {len(split['test'])} — {len(label_names)} classes")
    trainer.train()
    eval_result = trainer.evaluate()

    # ---- save the final model in standard HF layout ----
    trainer.save_model(str(ctx.model_out))
    tokenizer.save_pretrained(str(ctx.model_out))
    (ctx.model_out / "label_mapping.json").write_text(
        json.dumps({"label2id": label2id, "id2label": id2label}, indent=2),
        encoding="utf-8")

    return {
        "accuracy": round(float(eval_result.get("eval_accuracy", 0.0)), 4),
        "eval_loss": round(float(eval_result.get("eval_loss", 0.0)), 4),
        "num_classes": len(label_names),
        "train_rows": len(split["train"]),
        "eval_rows": len(split["test"]),
    }
