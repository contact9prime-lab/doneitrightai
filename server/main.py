"""TrainForge application entrypoint.

Run with::

    uvicorn server.main:app --host 0.0.0.0 --port 8000

(or just ``./run.sh``). One process serves both:

- the JSON API under ``/api/...`` (interactive docs at ``/docs``), and
- the web UI (static files from ``ui/``) at ``/``.

The UI is plain HTML/JS with no build step, so "deploy" is just this server.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from . import __version__, config, db
from .routers import agent, datasets, jobs, models, system

app = FastAPI(
    title="TrainForge",
    version=__version__,
    description="Self-hosted GPU ML training platform: import public data, "
                "train models, publish to the Hugging Face Hub.",
)

# Prepare disk + database before the first request.
config.ensure_dirs()
db.init_db()

app.include_router(system.router)
app.include_router(agent.router)
app.include_router(datasets.router)
app.include_router(jobs.router)
app.include_router(models.router)

# The UI is mounted last so /api and /docs win the route match.
# html=True serves ui/index.html at "/".
app.mount("/", StaticFiles(directory=config.APP_ROOT / "ui", html=True),
          name="ui")


if __name__ == "__main__":
    # Convenience: ``python -m server.main`` also works.
    import uvicorn

    uvicorn.run("server.main:app", host=config.HOST, port=config.PORT)
