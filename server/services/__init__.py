"""Service layer: everything the API routers delegate to.

- ``ingest``  — search + import datasets from public sources.
- ``runner``  — launch, watch, and stop training worker processes.
- ``publish`` — push trained models to the Hugging Face Hub.
- ``gpu``     — detect GPUs and installed ML capabilities.
"""
