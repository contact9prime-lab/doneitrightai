# Getting started

## Requirements

- Python **3.10+** on Linux or macOS (Windows: use WSL2)
- For deep-learning tasks: an NVIDIA GPU with a recent driver
  (`nvidia-smi` should work). Tabular tasks run fine on CPU.

## Install & run

```bash
git clone https://github.com/contact9prime-lab/doneitrightai.git
cd doneitrightai
./run.sh
```

`run.sh` creates a virtualenv, installs the core requirements (server, UI,
ingestion, tabular training, HF publishing), and starts the server on
**http://localhost:8000**. The UI is served by the same process; there is
nothing else to deploy.

### Enable GPU deep-learning tasks

```bash
.venv/bin/pip install -r requirements-gpu.txt
```

This adds `torch`, `transformers`, `accelerate`, and `peft`, enabling
**Text classification** and **LLM fine-tuning (LoRA)**. The header of the UI
shows a live GPU chip; the dashboard endpoint `/api/system/info` reports what
the training stack can see. If the chip says "CPU only" but you have a GPU,
see [troubleshooting](troubleshooting.md).

## Your first model (no GPU needed)

1. Open **Datasets** → *Upload a file* → pick `examples/penguins.csv`.
2. Open **Train** → task **Tabular classification** → set `label_column`
   to `species` (auto-detect suggests the lowest-cardinality column —
   `sex` here — which is also a valid target) → **Start training**.
3. Watch the job finish in seconds, then find the artifact under **Models**.

## Your first model, the agentic way

Open **Autopilot**, type a goal such as:

> a sentiment classifier for movie reviews

and press **Build my model**. The agent searches public datasets on the
Hugging Face Hub, imports the best candidate, configures a training job, and
watches it to completion. Every step appears in a live feed, and every
artifact (dataset, job, model) is a normal object you can inspect in the
manual tabs. See [autopilot.md](autopilot.md) for how it decides things.

## Configuration

All optional, via environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `TRAINFORGE_DATA_DIR` | `./data` | Where datasets, jobs, models, and the SQLite DB live |
| `TRAINFORGE_HOST` | `0.0.0.0` | Bind address |
| `TRAINFORGE_PORT` | `8000` | Port |
| `TRAINFORGE_MAX_CONCURRENT_JOBS` | `1` | Parallel training jobs (keep 1 per GPU) |
| `HF_TOKEN` | — | Hugging Face token (publishing, gated datasets) |
| `ANTHROPIC_API_KEY` | — | Enables the Claude-powered Autopilot planner |
| `TRAINFORGE_LLM_MODEL` | `claude-sonnet-5` | Model used by the LLM planner |

Backing up your installation = copying the data directory. Nothing else
holds state.

## Running as a service (systemd)

```ini
# /etc/systemd/system/trainforge.service
[Unit]
Description=TrainForge
After=network.target

[Service]
WorkingDirectory=/opt/trainforge
ExecStart=/opt/trainforge/run.sh
Restart=on-failure
Environment=HF_TOKEN=hf_...

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now trainforge
```

## Docker

CPU: `docker compose up --build`.
GPU: install the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/), then:

```bash
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up --build
```

State persists in the `trainforge-data` volume.
