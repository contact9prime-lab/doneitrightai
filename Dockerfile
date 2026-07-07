# TrainForge container image.
#
# Default build is CPU-only (small, fast). For GPU training pass
# WITH_GPU=1 and run with the NVIDIA Container Toolkit — see
# docker-compose.gpu.yml.

FROM python:3.11-slim

WORKDIR /app

# Layer-cache the dependency install: requirements change rarely.
COPY requirements.txt requirements-gpu.txt ./
ARG WITH_GPU=0
RUN pip install --no-cache-dir -r requirements.txt \
 && if [ "$WITH_GPU" = "1" ]; then pip install --no-cache-dir -r requirements-gpu.txt; fi

COPY server/ server/
COPY ui/ ui/

# All mutable state lives here — mount a volume to persist it.
ENV TRAINFORGE_DATA_DIR=/data
VOLUME /data

EXPOSE 8000
CMD ["uvicorn", "server.main:app", "--host", "0.0.0.0", "--port", "8000"]
