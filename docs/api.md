# API reference

Base URL: `http://localhost:8000`. Interactive OpenAPI docs are always live
at **`/docs`** (Swagger) and `/redoc`. All request/response bodies are JSON
unless noted. There is no authentication — see the security note in
[architecture.md](architecture.md).

## System

| Method & path | Description |
|---|---|
| `GET /api/system/health` | Liveness: `{"status":"ok","version":...}` |
| `GET /api/system/info` | GPUs (nvidia-smi), torch status, installed capabilities, data dir, HF-token presence |
| `GET /api/system/tasks` | Task catalog incl. hyperparameter schemas + availability (the UI's form source) |

## Autopilot

| Method & path | Description |
|---|---|
| `POST /api/agent/runs` | Start a run. Body: `{"goal": "…", "max_rows": 5000}` → `202` with the run row |
| `GET /api/agent/runs` | All runs, newest first |
| `GET /api/agent/runs/{id}` | One run; `steps` is the live activity feed |
| `GET /api/agent/status` | `{"llm_planner": bool}` — whether Claude planning is active |

Run statuses: `running → succeeded | failed`. A run links to the
`dataset_id` and `job_id` it created.

## Datasets

| Method & path | Description |
|---|---|
| `GET /api/datasets` | List datasets |
| `GET /api/datasets/search-hub?q=…&limit=25` | Keyword search over public HF Hub datasets |
| `POST /api/datasets/import-hub` | `{"repo_id","config_name?","split?","max_rows?","name?"}` → `202`, then poll |
| `POST /api/datasets/import-url` | `{"url","name?"}` → `202` (CSV/TSV/JSON/JSONL/Parquet) |
| `POST /api/datasets/upload` | multipart `file=…` (adds Excel) → `201` |
| `GET /api/datasets/{id}` | One dataset (poll for `status: importing → ready | failed`) |
| `GET /api/datasets/{id}/preview?rows=50` | First rows, column profile, suggested text/label columns |
| `DELETE /api/datasets/{id}` | Delete row + files |

## Jobs

| Method & path | Description |
|---|---|
| `GET /api/jobs` | List jobs (statuses reconciled against live PIDs) |
| `POST /api/jobs` | `{"name","dataset_id","task","base_model?","hyperparams?{}"}` → `201`, launched or queued |
| `GET /api/jobs/{id}` | One job |
| `GET /api/jobs/{id}/logs?offset=0` | Log tail; pass the returned `offset` back for incremental streaming |
| `GET /api/jobs/{id}/metrics` | All metric points (`[{time, step, loss, …}]`) |
| `POST /api/jobs/{id}/stop` | SIGTERM the worker's process group |
| `DELETE /api/jobs/{id}` | Delete a non-running job + its directory |

Job statuses: `queued → running → succeeded | failed | stopped`.
Unspecified hyperparameters take the defaults from `/api/system/tasks`.

## Models

| Method & path | Description |
|---|---|
| `GET /api/models` | Registry (successful jobs auto-register here) |
| `GET /api/models/{id}` | One model |
| `GET /api/models/{id}/files` | Artifact file listing (what publishing would upload) |
| `POST /api/models/{id}/publish` | `{"repo_id","private":true,"token?"}` → uploads to the HF Hub |
| `DELETE /api/models/{id}` | Delete row + files |

## End-to-end example (curl)

```bash
# import a public dataset (capped for speed)
curl -sX POST localhost:8000/api/datasets/import-hub \
  -H 'Content-Type: application/json' \
  -d '{"repo_id": "imdb", "max_rows": 2000}'
# ...poll GET /api/datasets/1 until "ready"

# train
curl -sX POST localhost:8000/api/jobs -H 'Content-Type: application/json' \
  -d '{"name":"imdb sentiment","dataset_id":1,"task":"text-classification",
       "base_model":"distilbert-base-uncased","hyperparams":{"epochs":1}}'

# watch
curl -s "localhost:8000/api/jobs/1/logs?offset=0"
curl -s  localhost:8000/api/jobs/1/metrics

# publish the registered model
curl -sX POST localhost:8000/api/models/1/publish \
  -H 'Content-Type: application/json' \
  -d '{"repo_id":"you/imdb-sentiment","private":true}'
```
