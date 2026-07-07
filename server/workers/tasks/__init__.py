"""Task registry.

Each task module exposes:

- ``SPEC``  — metadata + hyperparameter schema. The UI renders its training
  form directly from this, so adding a task here adds it to the product.
- ``train(ctx)`` — the actual trainer. Heavy libraries (torch, transformers,
  sklearn) are imported *inside* ``train`` so this registry is importable
  by the API server even on machines without the GPU stack installed.

To add a new task: create a module with SPEC + train(), register it in
``TASKS`` below, and it appears in the UI automatically.
"""

from __future__ import annotations

from . import causal_lm, tabular, text_classification

# task name -> module. Names must match schemas.TaskName.
TASKS = {
    "tabular-classification": tabular,
    "tabular-regression": tabular,
    "text-classification": text_classification,
    "causal-lm": causal_lm,
}


def all_specs() -> list[dict]:
    """Flat list of task specs for the API/UI (deduplicated by task name)."""
    specs = []
    for name, module in TASKS.items():
        for spec in module.SPEC:
            if spec["task"] == name:
                specs.append(spec)
    return specs
