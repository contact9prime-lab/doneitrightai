# TrainForge — agent handoff & project context

This file briefs an AI agent (or human) picking up development. Read it with
`docs/architecture.md` and you know everything load-bearing about the system.

## What this is

TrainForge: a self-hosted, GPU-ready ML training platform with a web UI.
MIT licensed. Users either describe a model in plain language (**Autopilot**
agentically searches public Hugging Face datasets, imports, configures,
trains, registers) or work manually (import/upload data → pick task → train →
publish to the HF Hub). Built and smoke-tested end-to-end in one session;
PR #2 tracks branch `claude/gpu-ml-training-platform-anj2rf`.

`recoil-mcp/` is an unrelated earlier project (TypeScript MCP server) kept
aside — do not touch it unless asked.

## Stack & layout (deliberate choices — keep them unless asked)

- **FastAPI + stdlib SQLite (WAL) + vanilla JS UI. No ORM, no build step,
  no CDN/external assets.** The product must work on an air-gapped GPU box.
- `server/routers/` HTTP layer → `server/services/` logic →
  `server/workers/` training processes. UI in `ui/` (index.html, app.js,
  styles.css). Docs in `docs/`. All runtime state under `data/` (gitignored).
- **Training always runs in a child process** (`server/services/runner.py`
  spawns `python -m server.workers.train_worker --job-id N`), never in the
  server: crash isolation, GPU memory reclamation, killable process groups.
  The runner "reaps" dead PIDs so jobs never stick at "running".
- **Heavy imports (torch/transformers/sklearn) live inside functions**, never
  at module top level. The server must boot and serve the UI with zero ML
  libraries installed; `/api/system/tasks` reports per-task availability.
- **All ingested data is normalized to Parquet** (`data/datasets/<id>/data.parquet`)
  with a stored column profile; text/label columns are auto-detected
  (`ingest.guess_text_column` / `guess_label_column`).
- **Live streaming is file-tailing + polling**, not websockets: workers write
  `job.log` and `metrics.jsonl`; the API returns byte offsets the client
  passes back. Keep it this way — survives any reverse proxy.
- **Task registry pattern**: each task module in `server/workers/tasks/`
  exposes `SPEC` (hyperparameter schema) + `train(ctx)`. The UI training form
  and `/api/system/tasks` are generated from SPEC — adding a task is one
  module + one line in `TASKS` (`tasks/__init__.py`), nothing else.
- **Autopilot** (`server/services/agent.py`) composes the same
  ingest/runner services as manual mode. Planning is heuristic by default,
  upgraded to Claude if `ANTHROPIC_API_KEY` is set (direct REST call, no SDK
  dep, silent fallback on any failure). Never make the platform hard-depend
  on an external API.

## How to run & verify

```bash
./run.sh                                        # venv + core deps + server on :8000
.venv/bin/pip install -r requirements-gpu.txt   # enables text-classification + causal-lm
```

Fast end-to-end check (CPU, ~30s): upload `examples/penguins.csv` via
`POST /api/datasets/upload`, create a `tabular-classification` job with
`{"label_column": "species"}`, poll `GET /api/jobs/1` → `succeeded` with
accuracy 1.0, model appears in `GET /api/models`. There is no test suite yet
(see gaps) — this manual loop plus `node --check ui/app.js` and
`python -m compileall server` was the verification bar so far.

## Verified vs unverified

Verified working (exercised in-session): server boot, capability/GPU
detection, CSV/Excel/URL ingestion, column auto-detect, tabular training
end-to-end, metrics/log streaming, loss chart + tooltip (screenshot-checked,
zero JS errors), job stop (process-group SIGTERM), full delete lifecycle
(models survive job/dataset deletion — they own copies), Autopilot planner
heuristics + graceful failure feed.

**Unverified** (the dev sandbox blocked huggingface.co): live Hub search
(`GET /api/datasets/search-hub`), Hub import, model publishing, and therefore
a full Autopilot run through training. Also never run on a real GPU:
`text_classification.py` and `causal_lm.py` (both follow standard
Trainer/PEFT patterns; expect minor version friction — e.g. we already fixed
`list_datasets(direction=...)` being removed in huggingface_hub 1.x, and
`TrainingArguments` renamed `evaluation_strategy`→`eval_strategy` in
transformers ≥4.46, which the code already uses). **First job on a GPU
machine: run one text-classification and one causal-lm job and fix what
surfaces.**

## Known gaps / natural roadmap

1. **No authentication** — designed for trusted LAN; docs say front it with a
   proxy. A simple token/basic-auth middleware would be the first shippable
   improvement if exposure matters.
2. **No test suite** — pytest over `ingest` (parsing/profiling/guessing),
   `runner` (launch/stop/reap with a stub worker), and API routes would pay
   off immediately; all pure-Python, no GPU needed.
3. **No inference/playground tab** — models can't be tried in the UI after
   training. Registry rows have `path` + `task`; a `POST /api/models/{id}/predict`
   plus a UI panel is a contained feature.
4. Autopilot imports only the `train` split with default config; datasets
   needing a config name (e.g. `glue`) are skipped rather than resolved.
5. Job queue is FIFO via `TRAINFORGE_MAX_CONCURRENT_JOBS` (default 1); no
   per-GPU scheduling or priorities.
6. Dataset versioning/lineage is single-shot (re-import = new dataset).
7. UI is dark-only by design; polling intervals are fixed constants in app.js.

## Conventions to preserve

- Every module opens with a docstring explaining *what and why* — keep that
  bar; inline comments state constraints, not narration.
- API responses are raw DB dicts (`db.row_to_dict`); only request bodies get
  Pydantic models (`server/schemas.py`). Adding a column = one schema string.
- UI: escape all interpolated text with `esc()`; one poller per view via
  `setPoll()` (cleared on navigation); chart series colors are fixed-order
  slots (`SERIES_COLORS`) from a validated dark palette — don't cycle hues,
  don't add a second y-axis.
- Tokens/secrets: env vars or per-request only. Never write them to disk/DB.
- Docs live in `docs/` and are part of the deliverable — update them with any
  behavior change. `docs/api.md` mirrors the routes; `/docs` (OpenAPI) is
  auto-generated.
