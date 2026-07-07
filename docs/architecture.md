# Architecture

TrainForge is a deliberately small system: one Python server, one SQLite
file, one directory of state, training in child processes. This page explains
the moving parts and the reasoning behind them.

```
browser ──HTTP──▶ FastAPI (server/main.py)
                    ├── routers/        thin HTTP layer
                    ├── services/
                    │     ingest.py     public data → data/datasets/<id>/data.parquet
                    │     agent.py      Autopilot pipeline (thread per run)
                    │     runner.py     spawns/stops/reaps worker processes
                    │     publish.py    model card + upload to HF Hub
                    │     gpu.py        nvidia-smi + torch probes
                    └── SQLite (data/trainforge.db, WAL)
                          ▲
                          │ status/metrics writes
      subprocess ─────────┴─ workers/train_worker.py ──▶ tasks/{tabular,text_classification,causal_lm}.py
                                                          └─ data/jobs/<id>/{job.log, metrics.jsonl, output/}
```

## Key decisions

**Training in child processes, never in the server.**
A CUDA OOM or native crash kills one job, not the platform; exiting the
process is the only reliable way to return GPU memory to the driver; and
stopping a job is `SIGTERM` to a process group (which also tears down
DataLoader workers). The runner "reaps" too: if a worker dies without
updating its row, the next status read detects the dead PID and marks the
job failed — no zombie "running" states.

**SQLite (WAL) instead of a database server.**
Three tables (+ agent runs), single-node by design. WAL allows the server
and workers to read/write concurrently; every write is a short autocommit
statement. Zero setup, and backup = copy one file.

**Everything normalized to Parquet.**
HF datasets, CSVs, Excel uploads — all become `data.parquet` + a stored
column profile. Trainers never care where data came from, and the profile
powers text/label auto-detection everywhere (UI prefills, Autopilot fit
checks, worker fallbacks).

**Files, not sockets, for live streaming.**
Workers append to `job.log` and `metrics.jsonl`; the API tails them with a
byte offset the client passes back. Plain polling survives reverse proxies,
needs no websocket infra, and makes logs durable artifacts for free.

**Zero-build UI.**
`ui/` is plain HTML/CSS/JS served by FastAPI. No node toolchain, no CDN —
the platform works on an air-gapped GPU box. The training form and the task
list are generated from the server's task registry (`/api/system/tasks`), so
the UI can't drift from the backend.

**Lazy heavy imports.**
`torch`/`transformers`/`sklearn` are imported inside `train()` functions and
service calls, never at module top level. The server boots instantly and runs
fully featured even before the GPU stack is installed; `/api/system/tasks`
reports which tasks are unavailable and what to install.

**Autopilot composes the same primitives.**
The agent calls the same ingest/runner services the manual UI uses, so every
artifact it creates is inspectable and re-runnable by hand. Planning is
heuristic by default and LLM-upgraded when a key is present — the platform
never hard-depends on an external API.

## Data layout

```
data/
├── trainforge.db            SQLite (datasets, jobs, models, agent_runs)
├── datasets/<id>/data.parquet
├── jobs/<id>/
│   ├── job.log              combined stdout/stderr of the worker
│   ├── metrics.jsonl        one JSON object per logged step
│   ├── checkpoints/         intermediate Trainer checkpoints (deep tasks)
│   └── output/              final artifact produced by the trainer
└── models/<id>/             registry copy of the artifact (survives job deletion)
```

## Security posture

Designed for a trusted machine/LAN: there is **no authentication built in**.
If you expose it beyond localhost, put it behind a reverse proxy with auth
(e.g. Caddy/nginx + basic auth, Tailscale, or a VPN). HF tokens are read from
the environment or per-request bodies and are never written to disk or DB.
