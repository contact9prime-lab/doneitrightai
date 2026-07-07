# Troubleshooting

## The header says "CPU only" but I have an NVIDIA GPU

1. `nvidia-smi` in a terminal — if it fails, install/repair the NVIDIA
   driver first; nothing else can work without it.
2. Check `/api/system/info`: if `torch.installed` is `false`, run
   `.venv/bin/pip install -r requirements-gpu.txt`.
3. If torch is installed but `cuda_available` is `false`, you likely got a
   CPU-only wheel. Reinstall per <https://pytorch.org/get-started/locally/>
   for your CUDA version.
4. Docker: use the GPU overlay (`docker-compose.gpu.yml`) and make sure the
   NVIDIA Container Toolkit is installed.

## CUDA out of memory during training

In order of preference:

- halve `batch_size` (for causal-lm, double `gradient_accumulation` to keep
  the effective batch);
- reduce `max_length`;
- pick a smaller base model (see the VRAM table in
  [training-tasks.md](training-tasks.md));
- make sure nothing else is using the GPU (`nvidia-smi`).

## A job is stuck on "running"

The UI reconciles statuses against live PIDs on every poll — if the worker
died, the job flips to `failed` automatically. If it is genuinely running but
silent, check the log panel (Trainer only logs every few steps; the first
step of a large model can take minutes while weights download).

## Dataset import failed

- The error is stored on the dataset row (shown in the Datasets table).
- Hub imports: some datasets need a config name (e.g. `glue` → `sst2`) —
  set it in the import call, or pick the specific subset dataset instead.
  Gated datasets need `HF_TOKEN` with accepted terms.
- URL imports must be *direct file links* (CSV/TSV/JSON/JSONL/Parquet), not
  landing pages.
- Excel uploads use the first sheet only.

## Autopilot picked a bad dataset / failed all candidates

The heuristic planner is keyword-based; be more specific ("classify German
news by topic" rather than "news model"), raise `max_rows`, or set
`ANTHROPIC_API_KEY` to let Claude plan. You can always import the right
dataset yourself and train manually — Autopilot has no special powers.

## Publishing fails with 401

The token lacks the **write** role, or no token was provided (`HF_TOKEN`
unset and dialog field left blank). Repo ids must be `username/name` where
`username` is *your* account or an org you can write to.

## Port already in use

`TRAINFORGE_PORT=9000 ./run.sh`

## Where is everything on disk?

`data/` (or `TRAINFORGE_DATA_DIR`) — see the layout map in
[architecture.md](architecture.md). Deleting a job directory never breaks a
registered model; the registry keeps its own copy.

## Reset the whole platform

Stop the server, delete the data directory, start again. That's the entire
state.
