# Training tasks

Each task is a module in `server/workers/tasks/` exposing a `SPEC`
(hyperparameter schema — the UI form is generated from it) and a `train()`
function. This page covers what each task does, its knobs, and how to use the
resulting artifact.

Auto-detection: for text/label columns, TrainForge prefers conventional names
(`text`, `sentence`, `label`, `target`, …), then falls back to
longest-average-string (text) and lowest-cardinality (label). Every trainer
accepts explicit `*_column` overrides.

---

## Tabular classification / regression (scikit-learn, CPU-friendly)

Spreadsheet-style rows → predict a category or a number. Builds a leak-free
pipeline: median/most-frequent imputation, scaling, one-hot encoding
(high-cardinality text columns are dropped automatically), then the chosen
estimator.

| Hyperparameter | Default | Notes |
|---|---|---|
| `label_column` | auto | target column |
| `algorithm` | `random_forest` | or `gradient_boosting`, `logistic_regression` / `linear_regression` |
| `n_estimators` | 300 | trees for forest/boosting |
| `max_depth` | 0 (unlimited) | tree depth cap |
| `test_size` | 0.2 | held-out fraction |
| `seed` | 42 | reproducibility |

**Metrics:** accuracy + macro-F1 (classification); MAE, RMSE, R² (regression).

**Artifact:** `model.joblib` (full pipeline) + `inference.json` (expected
columns):

```python
import joblib, pandas as pd
pipe = joblib.load("model.joblib")
pipe.predict(pd.DataFrame([{"bill_length_mm": 39.1, "island": "Torgersen", ...}]))
```

---

## Text classification (Transformers, GPU recommended)

Fine-tunes any HF sequence-classification checkpoint on a text + label pair.
Mixed precision on GPU, best-epoch checkpoint restored at the end.

| Hyperparameter | Default | Notes |
|---|---|---|
| `text_column` / `label_column` | auto | |
| `epochs` | 3 | |
| `learning_rate` | 5e-5 | |
| `batch_size` | 16 | halve it on CUDA OOM |
| `max_length` | 256 | token truncation |
| `eval_fraction` | 0.1 | |
| `seed` | 42 | |

Base model: any encoder from the Hub (`distilbert-base-uncased` default;
`bert-base-uncased`, `roberta-base`, multilingual variants, …).

**Metrics:** accuracy + eval loss per epoch, streamed to the loss chart.

**Artifact:** standard HF layout + `label_mapping.json`:

```python
from transformers import pipeline
clf = pipeline("text-classification", model="path-or-repo")
clf("What a fantastic movie!")
```

---

## LLM fine-tuning — causal-lm (LoRA/PEFT, GPU required in practice)

Fine-tunes a decoder-only LM on your text using LoRA adapters (only ~1% of
parameters train — this is what makes single-GPU fine-tuning practical).
Handles two data shapes automatically:

- **plain text** — a single text column;
- **instruction pairs** — `instruction`/`output`, `prompt`/`response`,
  `question`/`answer` (or explicit `prompt_column`/`response_column`),
  formatted with an instruction template.

| Hyperparameter | Default | Notes |
|---|---|---|
| `epochs` | 1 | |
| `learning_rate` | 2e-4 | LoRA sweet spot ~1e-4..3e-4 |
| `batch_size` × `gradient_accumulation` | 2 × 8 | effective batch 16 |
| `max_length` | 512 | sequence length |
| `lora_r` / `lora_alpha` | 16 / 32 | adapter capacity / scaling |
| `merge_adapter` | true | save a standalone model (false = small adapter only) |
| `eval_fraction` | 0.05 | |

Base model: `TinyLlama/TinyLlama-1.1B-Chat-v1.0` by default; any Llama-,
Mistral- or GPT-style causal LM works (VRAM permitting — see sizing below).

**Artifact (merged):**

```python
from transformers import pipeline
lm = pipeline("text-generation", model="path-or-repo")
lm("### Instruction:\nHow do I poach an egg?\n\n### Response:\n")
```

### VRAM sizing rule of thumb (LoRA, bf16)

| Base model | Min VRAM |
|---|---|
| ≤1.5B (TinyLlama) | 8 GB |
| 3B | 12 GB |
| 7–8B (Llama, Mistral) | 24 GB |

On OOM: lower `batch_size` (raise `gradient_accumulation` to compensate),
lower `max_length`, or pick a smaller base model.

---

## Adding your own task

1. Create `server/workers/tasks/my_task.py` with a `SPEC` list and a
   `train(ctx)` function (see `tabular.py` for the smallest example —
   `ctx` gives you the DataFrame, merged hyperparams, output dir, and
   `log_metrics()`/`say()` for streaming).
2. Register it in `TASKS` in `server/workers/tasks/__init__.py`.

That's it — the API lists it and the UI renders its form automatically.
Keep heavy imports inside `train()` so the server stays importable.
