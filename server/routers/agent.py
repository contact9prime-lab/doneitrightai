"""Autopilot endpoints — the agentic model-building pipeline.

POST a goal, poll the run: the agent searches public data, imports the best
candidate, configures a job, trains it, and registers the model. See
``server.services.agent`` for the pipeline itself.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .. import db
from ..services import agent

router = APIRouter(prefix="/api/agent", tags=["agent"])


class AgentRunRequest(BaseModel):
    goal: str = Field(..., min_length=3, max_length=2000,
                      description="Plain-language description of the model "
                                  "you want, e.g. 'a sentiment classifier "
                                  "for movie reviews'")
    max_rows: int | None = Field(
        None, ge=50, description="Row cap for the imported dataset "
                                 "(default 5000 — fast first results)")


@router.get("/runs")
def list_runs() -> list[dict]:
    return db.list_agent_runs()


@router.post("/runs", status_code=202)
def start_run(req: AgentRunRequest) -> dict:
    """Kick off an Autopilot run. Returns immediately; poll GET /runs/{id}
    to stream the live step feed."""
    return agent.start(req.goal, req.max_rows)


@router.get("/runs/{run_id}")
def get_run(run_id: int) -> dict:
    run = db.get_agent_run(run_id)
    if run is None:
        raise HTTPException(404, "Run not found")
    return run


@router.get("/status")
def status() -> dict:
    """Whether the optional LLM planner is active (never exposes the key)."""
    return {"llm_planner": agent.llm_available()}
