# ⚒️ TrainForge

**A self-hosted, GPU-ready machine-learning training platform with a web UI.**
Describe a model or bring your own data — TrainForge finds public datasets,
trains on your hardware, and publishes to the Hugging Face Hub. MIT licensed.

```
┌─────────────────────────────────────────────────────────────────┐
│  Web UI  (zero-build, works offline)                            │
│  Autopilot · Datasets · Train · Jobs · Models                   │
├─────────────────────────────────────────────────────────────────┤
│  FastAPI server (/api)                                          │
│   ├─ Agent: goal → search → import → configure → train → model  │
│   ├─ Ingestion: HF Hub search / URL / upload  → Parquet         │
│   ├─ Job runner: one isolated process per training job          │
│   └─ Publisher: model card + upload to Hugging Face Hub         │
├─────────────────────────────────────────────────────────────────┤
│  Training workers (your GPU)                                    │
│   text-classification · causal-lm (LoRA) · tabular (sklearn)    │
└─────────────────────────────────────────────────────────────────┘
```

## Highlights

- **Autopilot (agentic mode)** — type *"a sentiment classifier for movie
  reviews"* and the agent searches public datasets, imports the best fit,
  maps columns, configures a job, trains it, and registers the model. Works
  offline with built-in heuristics; add `ANTHROPIC_API_KEY` and Claude does
  the planning.
- **Manual mode** — search the Hugging Face Hub, import any URL, or upload
  CSV/JSON/Parquet/Excel; pick a task; tweak hyperparameters in a form
  generated from the task registry.
- **Real training on your GPU** — Transformers fine-tuning (text
  classification), LLM fine-tuning with LoRA (PEFT), and scikit-learn tabular
  models that run even without a GPU.
- **Live monitoring** — streaming logs, loss chart, and metric tiles while a
  job runs; jobs are isolated processes you can stop safely.
- **One-click publishing** — models upload to the Hugging Face Hub with an
  auto-generated model card (private by default).
- **Boring, dependable tech** — FastAPI + SQLite + vanilla JS. No build
  step, no external services, one directory (`data/`) holds all state.

## Quickstart

Requirements: Python 3.10+, Linux/macOS (or WSL2). NVIDIA GPU + driver
recommended for the deep-learning tasks.

```bash
git clone https://github.com/contact9prime-lab/doneitrightai.git
cd doneitrightai
./run.sh                      # creates .venv, installs core deps, starts the server
```

Open **http://localhost:8000** — that's the whole deployment.

Enable the GPU tasks (text-classification, causal-lm):

```bash
.venv/bin/pip install -r requirements-gpu.txt
```

Optional environment:

```bash
export HF_TOKEN=hf_...            # publish models / access gated datasets
export ANTHROPIC_API_KEY=sk-...   # smarter Autopilot planning (optional)
```

### 60-second smoke test (no GPU needed)

1. **Datasets → Search public datasets** → try `iris`, or **Upload** the
   included `examples/penguins.csv`.
2. **Train** → task *Tabular classification* → **Start training** — finishes
   in seconds.
3. **Models** → your model is registered; click **Publish** to push it to
   the Hugging Face Hub.

Or skip all of that: open **Autopilot** and type what you want.

## Docker

```bash
docker compose up --build        # CPU
# GPU: requires the NVIDIA Container Toolkit
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up --build
```

## Documentation

| Doc | What's inside |
|---|---|
| [docs/getting-started.md](docs/getting-started.md) | Install, first model, GPU setup, configuration |
| [docs/autopilot.md](docs/autopilot.md) | How the agentic pipeline works, planners, tuning |
| [docs/training-tasks.md](docs/training-tasks.md) | Every task, its hyperparameters, and using the artifacts |
| [docs/api.md](docs/api.md) | Full REST API reference (also live at `/docs`) |
| [docs/architecture.md](docs/architecture.md) | How it's built: processes, storage, design decisions |
| [docs/publishing-to-huggingface.md](docs/publishing-to-huggingface.md) | Tokens, model cards, private repos |
| [docs/troubleshooting.md](docs/troubleshooting.md) | CUDA OOM, import failures, common fixes |

The codebase is deliberately readable — every module opens with a docstring
explaining what it does and why; start at `server/main.py` and follow the
imports.

## Repository layout

```
server/          FastAPI app, services, training workers
ui/              zero-build web UI (HTML/CSS/JS)
docs/            documentation
examples/        sample data for the smoke test
data/            created at runtime — all state lives here (gitignored)
recoil-mcp/      unrelated earlier project, kept aside
```

## License

[MIT](LICENSE) — use it, fork it, ship it.
