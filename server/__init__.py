"""TrainForge — a self-hosted, GPU-ready machine-learning training platform.

The ``server`` package contains everything that runs on your machine:

- ``server.main``      — the FastAPI application (API + web UI).
- ``server.config``    — environment-driven configuration.
- ``server.db``        — the SQLite persistence layer (datasets, jobs, models).
- ``server.routers``   — the HTTP API, grouped by resource.
- ``server.services``  — dataset ingestion, the job runner, GPU detection,
                         and Hugging Face publishing.
- ``server.workers``   — training processes launched by the job runner.

Start the platform with::

    uvicorn server.main:app --host 0.0.0.0 --port 8000

or simply ``./run.sh`` from the repository root.
"""

__version__ = "0.1.0"
