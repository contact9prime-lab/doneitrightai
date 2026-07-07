"""HTTP API routers, one module per resource:

- ``system``   — health, GPU info, capabilities, task catalog.
- ``datasets`` — search public sources, import, preview, delete.
- ``jobs``     — create/launch training jobs, logs, metrics, stop.
- ``models``   — registry + publish to the Hugging Face Hub.

All routes live under ``/api``; full reference in ``docs/api.md``.
"""
