"""Training worker processes.

The API server never trains anything itself. ``server.services.runner``
launches ``server.workers.train_worker`` as a separate OS process per job;
that process dispatches to one of the task trainers in ``workers.tasks``.
"""
