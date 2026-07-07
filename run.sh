#!/usr/bin/env bash
# TrainForge launcher — the "works out of the box" path.
#
# Creates a virtualenv on first run, installs core requirements, and starts
# the server. Re-running it just starts the server (fast).
#
#   ./run.sh                 # http://localhost:8000
#   TRAINFORGE_PORT=9000 ./run.sh
#
# GPU deep-learning tasks additionally need:
#   .venv/bin/pip install -r requirements-gpu.txt

set -euo pipefail
cd "$(dirname "$0")"

PY="${PYTHON:-python3}"

if [ ! -d .venv ]; then
  echo "==> Creating virtualenv (.venv) and installing requirements…"
  "$PY" -m venv .venv
  .venv/bin/pip install --upgrade pip -q
  .venv/bin/pip install -r requirements.txt
fi

HOST="${TRAINFORGE_HOST:-0.0.0.0}"
PORT="${TRAINFORGE_PORT:-8000}"
echo "==> TrainForge starting on http://localhost:${PORT}"
exec .venv/bin/uvicorn server.main:app --host "$HOST" --port "$PORT"
