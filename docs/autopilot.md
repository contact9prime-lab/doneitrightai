# Autopilot — the agentic pipeline

Autopilot turns a plain-language goal into a trained, registered model. It is
implemented in `server/services/agent.py`; this page explains its behavior so
you can predict and steer it.

## The pipeline

| Step | What happens | Where to look |
|---|---|---|
| 1. Understand | Goal → task type + dataset search queries | live step feed |
| 2. Search | Queries run against the public Hugging Face Hub, deduped, ranked by downloads | step feed lists candidates |
| 3. Import | Best candidate is imported (capped at *max rows*, default 5000). If import fails or the data doesn't fit, the next candidate is tried (up to 4) | **Datasets** tab |
| 4. Analyze | Columns are profiled; text/label columns auto-mapped; fit is validated (e.g. classification needs a 2–100-class label) | step feed |
| 5. Configure | Task defaults + detected columns → hyperparameters; base model chosen per task | step feed |
| 6. Train | A normal TrainForge job is launched and watched to completion | **Jobs** tab (live logs + loss chart) |

On success the model lands in **Models** like any manual run, ready to
publish. On failure the run shows exactly which step failed and why, and the
partial artifacts remain for inspection.

## Two planners

**Heuristic planner (default, offline).** Keyword rules pick the task
(e.g. "sentiment/classify/spam" → text-classification, "price/forecast" →
tabular-regression, "fine-tune/chatbot" → causal-lm) and the goal's keywords
become search queries. No external calls, no API keys.

**LLM planner (optional).** If `ANTHROPIC_API_KEY` is set, Claude picks the
task and search queries, and re-ranks the dataset candidates. Any LLM failure
silently falls back to the heuristics — Autopilot never hard-depends on it.
Override the model with `TRAINFORGE_LLM_MODEL` (default `claude-sonnet-5`).

## Defaults it chooses

| Task | Base model | Notes |
|---|---|---|
| text-classification | `distilbert-base-uncased` | 2 epochs on the imported sample |
| causal-lm | `TinyLlama/TinyLlama-1.1B-Chat-v1.0` | LoRA, merged on save |
| tabular-* | scikit-learn random forest | label auto-detected |

These are deliberately small/fast "first result" choices. For a bigger model
or more data, open the job in **Jobs**, note its configuration, and re-run it
from **Train** with your changes — Autopilot artifacts are ordinary objects.

## Steering it

- **Be specific.** "classify German news articles by topic" finds better data
  than "make a text model".
- **Raise *max rows*** for a better model once the fast run works end-to-end.
- **Bring your own data instead**: import/upload in **Datasets**, then use
  **Train** — Autopilot is optional, not the only path.

## API

```bash
curl -X POST localhost:8000/api/agent/runs \
  -H 'Content-Type: application/json' \
  -d '{"goal": "a sentiment classifier for movie reviews", "max_rows": 5000}'
# → {"id": 1, "status": "running", ...}
curl localhost:8000/api/agent/runs/1     # live steps
```
